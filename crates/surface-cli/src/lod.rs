//! Offline LOD conversion. Only the region index scales with source size; terrain
//! buffers consist of one cached region and up to four summary pages per level.
use crate::{atomic_write, hash};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    time::Instant,
};
use surface_core::lod::*;
use surface_core::terrain::SurfaceChunk;
use surface_core::{
    MAX_DECOMPRESSED, MapManifest, Material, RegionRef, SurfaceRegion, decode_region, decompress,
    encode_live_region,
};

const MAX_SOURCE_JSON: usize = 64 * 1024 * 1024;
const FIXTURE_SIDE: usize = 1024;
const FIXTURE_HEIGHT_BYTES: usize = FIXTURE_SIDE * FIXTURE_SIDE * 2;

#[derive(Clone, Copy, Debug, Default)]
pub struct LodFixtureOptions {
    pub legacy_reference: bool,
}

fn read_bounded(path: &Path, limit: usize) -> Result<Vec<u8>> {
    let file = fs::File::open(path).with_context(|| format!("read {}", path.display()))?;
    ensure!(
        file.metadata()?.len() <= limit as u64,
        "source file exceeds byte limit"
    );
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= limit, "source file grew past byte limit");
    Ok(bytes)
}

fn source_path(root: &Path, url: &str) -> Result<PathBuf> {
    ensure!(
        !url.is_empty()
            && url.len() <= 512
            && !url.contains(['\\', '?', '#', '%', ':'])
            && Path::new(url)
                .components()
                .all(|part| matches!(part, Component::Normal(_))),
        "source URL must be a local relative path"
    );
    let root = root.canonicalize()?;
    let path = root.join(url).canonicalize()?;
    ensure!(
        path.starts_with(root),
        "source object escapes map directory"
    );
    Ok(path)
}

fn read_object(root: &Path, object: &ObjectRef, limit: usize) -> Result<Vec<u8>> {
    object.validate(limit)?;
    let bytes = read_bounded(&source_path(root, &object.url)?, limit)?;
    ensure!(
        bytes.len() == object.bytes && hash(&bytes) == object.sha256,
        "source object length/hash mismatch: {}",
        object.url
    );
    Ok(bytes)
}

fn object(output: &Path, suffix: &str, bytes: &[u8]) -> Result<ObjectRef> {
    let sha256 = hash(bytes);
    let url = format!("objects/{sha256}.{suffix}");
    atomic_write(&output.join(&url), bytes)?;
    Ok(ObjectRef {
        url,
        sha256,
        bytes: bytes.len(),
    })
}

fn packed(output: &Path, raw: &[u8]) -> Result<ObjectRef> {
    ensure!(
        raw.len() <= MAX_TILE_BYTES,
        "decoded LOD object exceeds 2 MiB"
    );
    let mut encoder = zstd::stream::Encoder::new(Vec::new(), 3)?;
    encoder.include_checksum(true)?;
    std::io::Write::write_all(&mut encoder, raw)?;
    let bytes = encoder.finish()?;
    ensure!(
        bytes.len() <= MAX_TILE_BYTES && decompress_lod(&bytes)? == raw,
        "LOD compression verification failed"
    );
    object(output, "zst", &bytes)
}

#[derive(Clone)]
struct SourceRegion {
    surface: ObjectRef,
    index: Option<ObjectRef>,
}

struct CachedRegion {
    region: SurfaceRegion,
    chunks: Vec<ChunkRef>,
}

struct Builder<'a> {
    source: &'a Path,
    output: &'a Path,
    bounds: [i32; 4],
    materials: &'a [Material],
    regions: BTreeMap<(i32, i32), SourceRegion>, // z, x: permits bounded row lookups
    cached: Option<CachedRegion>,
    range: [i16; 2],
}

fn intersects(a: [i32; 4], b: [i32; 4]) -> bool {
    a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
}

impl Builder<'_> {
    fn has_source(&self, key: TileKey) -> Result<bool> {
        let b = key.bounds()?;
        let min_z = b[1].max(self.bounds[1]).div_euclid(256);
        let max_z = (b[3].min(self.bounds[3]) - 1).div_euclid(256);
        let min_x = b[0].max(self.bounds[0]).div_euclid(256);
        let max_x = (b[2].min(self.bounds[2]) - 1).div_euclid(256);
        Ok(self
            .regions
            .range((min_z, i32::MIN)..=(max_z, i32::MAX))
            .any(|((_, x), _)| (min_x..=max_x).contains(x)))
    }

    fn load_region(&mut self, rx: i32, rz: i32) -> Result<()> {
        if self
            .cached
            .as_ref()
            .is_some_and(|c| c.region.rx == rx && c.region.rz == rz)
        {
            return Ok(());
        }
        self.cached = None;
        let Some(source) = self.regions.get(&(rz, rx)) else {
            return Ok(());
        };
        let bytes = read_object(self.source, &source.surface, MAX_DECOMPRESSED)?;
        let region = decode_region(&decompress(&bytes, MAX_DECOMPRESSED)?)?;
        ensure!(
            (region.rx, region.rz) == (rx, rz),
            "source region coordinate mismatch"
        );
        let mut chunks = Vec::new();
        if let Some(index) = &source.index {
            let index: Value =
                serde_json::from_slice(&read_object(self.source, index, MAX_TILE_BYTES)?)?;
            ensure!(
                index["rx"].as_i64() == Some(rx as i64) && index["rz"].as_i64() == Some(rz as i64),
                "source index coordinate mismatch"
            );
            let indexed_surface: ObjectRef = serde_json::from_value(index["surface"].clone())?;
            ensure!(
                indexed_surface == source.surface,
                "source index surface mismatch"
            );
            if let Some(entries) = index["chunks"].as_object() {
                ensure!(entries.len() <= 256, "too many source chunks in region");
                for (key, value) in entries {
                    let (cx, cz) = key.split_once(',').context("source chunk coordinate key")?;
                    let (cx, cz): (i32, i32) = (cx.parse()?, cz.parse()?);
                    ensure!(
                        cx.div_euclid(16) == rx && cz.div_euclid(16) == rz,
                        "source chunk outside region"
                    );
                    let reference: ObjectRef = serde_json::from_value(value.clone())?;
                    let bytes = read_object(self.source, &reference, MAX_TILE_BYTES)?;
                    let chunk = SurfaceChunk::decode(&decompress(&bytes, 32 * 1024)?)?;
                    ensure!(
                        chunk == SurfaceChunk::from_region(&region, cx, cz)?,
                        "source chunk disagrees with region"
                    );
                    chunks.push(ChunkRef {
                        cx,
                        cz,
                        object: object(self.output, "zst", &bytes)?,
                    });
                }
            }
        }
        self.cached = Some(CachedRegion { region, chunks });
        Ok(())
    }

    fn detail(&mut self, key: TileKey) -> Result<(DetailTile, Vec<ChunkRef>)> {
        self.load_region(key.x.div_euclid(2), key.z.div_euclid(2))?;
        let (mut tile, chunks) = if let Some(cached) = &self.cached {
            (
                DetailTile::from_region(&cached.region, key)?,
                cached
                    .chunks
                    .iter()
                    .filter(|c| c.cx.div_euclid(8) == key.x && c.cz.div_euclid(8) == key.z)
                    .cloned()
                    .collect(),
            )
        } else {
            (DetailTile::unknown(key)?, Vec::new())
        };
        let b = key.bounds()?;
        for (i, c) in tile.columns.iter_mut().enumerate() {
            let x = b[0] + (i % 128) as i32;
            let z = b[1] + (i / 128) as i32;
            if x < self.bounds[0]
                || x >= self.bounds[2]
                || z < self.bounds[1]
                || z >= self.bounds[3]
            {
                *c = OUTSIDE_COLUMN;
            } else if c[0] == 1 {
                self.range[0] = self.range[0].min(c[1] as i16);
                self.range[1] = self.range[1].max(c[1] as i16);
            }
        }
        Ok((tile, chunks))
    }

    fn build(&mut self, key: TileKey) -> Result<(SummaryTile, Option<NodeRef>)> {
        if !intersects(key.bounds()?, self.bounds) {
            return Ok((SummaryTile::absent(key, self.bounds)?, None));
        }
        let mut children = Vec::new();
        let (summary, data, height, chunks) = if key.level == 0 {
            let (tile, chunks) = self.detail(key)?;
            let summary = SummaryTile::from_detail(&tile, self.materials)?;
            let raw = tile.encode()?;
            ensure!(
                DetailTile::decode(&raw)? == tile,
                "detail codec verification"
            );
            let data = packed(self.output, &raw)?;
            (summary, data, HeightTile::from_detail(&tile)?, chunks)
        } else {
            let summary = if self.has_source(key)? {
                let mut summaries = Vec::with_capacity(4);
                for child in key.children()? {
                    let (summary, reference) = self.build(child)?;
                    summaries.push(summary);
                    if let Some(reference) = reference {
                        children.push(reference);
                    }
                }
                SummaryTile::from_children(
                    key,
                    [&summaries[0], &summaries[1], &summaries[2], &summaries[3]],
                )?
            } else {
                SummaryTile::absent(key, self.bounds)?
            };
            let raw = summary.encode()?;
            ensure!(
                SummaryTile::decode(&raw)? == summary,
                "summary codec verification"
            );
            let data = packed(self.output, &raw)?;
            let height = HeightTile::from_summary(&summary)?;
            (summary, data, height, Vec::new())
        };
        let raw = height.encode()?;
        ensure!(
            HeightTile::decode(&raw)? == height,
            "height codec verification"
        );
        let height = packed(self.output, &raw)?;
        let node = LodNode {
            key,
            data,
            height,
            children,
            chunks,
        };
        let index = object(self.output, "json", &node.encode()?)?;
        Ok((summary, Some(NodeRef { key, index })))
    }
}

/// Convert a local v1 offline or v2 surface manifest without loading its global
/// height field. Source files remain untouched; the descriptor is published last.
pub fn prepare_lod(map: &Path, output: &Path) -> Result<LodManifest> {
    let map = map.canonicalize()?;
    let source = map.parent().context("manifest parent")?;
    let source_bytes = read_bounded(&map, MAX_SOURCE_JSON)?;
    let manifest: Value = serde_json::from_slice(&source_bytes)?;
    let version = manifest["format_version"]
        .as_u64()
        .context("source format version")?;
    ensure!(
        version == 1 || version == 2,
        "unsupported source manifest version"
    );
    let bounds: [i32; 4] = serde_json::from_value(manifest["bounds"].clone())?;
    let roots = root_keys(bounds)?;
    let materials: Vec<Material> = if version == 1 {
        serde_json::from_value(manifest["materials"].clone())?
    } else {
        let reference: ObjectRef = serde_json::from_value(manifest["catalog"].clone())?;
        serde_json::from_slice(&read_object(source, &reference, MAX_SOURCE_JSON)?)?
    };
    validate_materials(&materials)?;
    let atlas_bytes = if version == 1 {
        read_bounded(
            &source_path(
                source,
                manifest["atlas"].as_str().context("source atlas URL")?,
            )?,
            MAX_ATLAS_BYTES,
        )?
    } else {
        read_object(
            source,
            &serde_json::from_value(manifest["atlas"].clone())?,
            MAX_ATLAS_BYTES,
        )?
    };
    ensure!(
        atlas_bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "source atlas must be PNG"
    );
    let mut regions = BTreeMap::new();
    for entry in manifest["regions"]
        .as_array()
        .context("source regions array")?
    {
        let rx: i32 = serde_json::from_value(entry["rx"].clone())?;
        let rz: i32 = serde_json::from_value(entry["rz"].clone())?;
        ensure!(
            (-32768..32768).contains(&rx) && (-32768..32768).contains(&rz),
            "source region coordinate limit"
        );
        let index = if version == 2 && !entry["index"].is_null() {
            Some(serde_json::from_value::<ObjectRef>(entry["index"].clone())?)
        } else {
            None
        };
        let surface = if version == 1 {
            let r: RegionRef = serde_json::from_value(entry.clone())?;
            ObjectRef {
                url: r.url,
                sha256: r.sha256,
                bytes: r.bytes,
            }
        } else if !entry["surface"].is_null() {
            serde_json::from_value(entry["surface"].clone())?
        } else {
            let index: Value = serde_json::from_slice(&read_object(
                source,
                index.as_ref().context("source region index")?,
                MAX_TILE_BYTES,
            )?)?;
            serde_json::from_value(index["surface"].clone())?
        };
        surface.validate(MAX_DECOMPRESSED)?;
        ensure!(
            regions
                .insert((rz, rx), SourceRegion { surface, index })
                .is_none(),
            "duplicate source region"
        );
    }
    fs::create_dir_all(output)?;
    let atlas = object(output, "png", &atlas_bytes)?;
    let catalog = publish_catalog(output, &materials)?;
    let mut builder = Builder {
        source,
        output,
        bounds,
        materials: &materials,
        regions,
        cached: None,
        range: [i16::MAX, i16::MIN],
    };
    let mut references = Vec::new();
    for root in roots {
        references.push(builder.build(root)?.1.context("missing root")?);
    }
    let range = if builder.range[0] <= builder.range[1] {
        builder.range
    } else {
        [0, 0]
    };
    let result = LodManifest {
        format_version: 1,
        kind: "surface-lod".into(),
        name: manifest["name"].as_str().context("source map name")?.into(),
        bounds,
        spawn: serde_json::from_value(manifest["spawn"].clone())?,
        source_sha256: match manifest["source_sha256"].as_str() {
            Some(s) if s.len() == 64 && s.bytes().all(|c| c.is_ascii_hexdigit()) => {
                s.to_ascii_lowercase()
            }
            _ => hash(&source_bytes),
        },
        generation: manifest["generation"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| format!("offline-{}", hash(&source_bytes))),
        world_id: manifest["world_id"].as_str().map(str::to_owned),
        revision: manifest["revision"].as_u64().unwrap_or(1),
        appearance_version: APPEARANCE_VERSION.into(),
        height_range: range,
        atlas,
        catalog,
        material_count: materials.len(),
        roots: references,
    };
    atomic_write(&output.join("lod.json"), &result.encode()?)?;
    Ok(result)
}

fn publish_catalog(output: &Path, materials: &[Material]) -> Result<Vec<CatalogPageRef>> {
    let mut pages = Vec::new();
    let mut start = 0;
    while start < materials.len() {
        let mut count = 0;
        let mut bytes = 2;
        for m in materials.iter().skip(start).take(CATALOG_PAGE_SIZE) {
            let size = serde_json::to_vec(m)?.len();
            ensure!(
                size + 2 <= MAX_CATALOG_PAGE_BYTES,
                "one material exceeds the 64 KiB catalog page limit"
            );
            let next = bytes + size + usize::from(count > 0);
            if next > MAX_CATALOG_PAGE_BYTES {
                break;
            }
            bytes = next;
            count += 1;
        }
        ensure!(
            pages.len() < 256,
            "catalog needs more than 256 pages; structural catalog paging is not supported in LOD v1"
        );
        let raw = serde_json::to_vec(&materials[start..start + count])?;
        ensure!(
            raw.len() <= MAX_CATALOG_PAGE_BYTES,
            "catalog page JSON limit"
        );
        pages.push(CatalogPageRef {
            start,
            count,
            object: object(output, "json", &raw)?,
        });
        start += count;
    }
    Ok(pages)
}

fn fixture_materials() -> Vec<Material> {
    [
        ("unknown", 0, [1., 0., 1., 1.]),
        ("grass", 1, [0.62, 0.62, 0.62, 1.]),
        ("stone", 0, [0.52, 0.55, 0.59, 1.]),
        ("sand", 0, [0.84, 0.78, 0.58, 1.]),
        ("water", 3, [0.18, 0.48, 0.72, 1.]),
        ("snow_layer", 0, [0.94, 0.97, 1., 0.8]),
        ("leaves", 2, [0.48, 0.48, 0.48, 0.85]),
        ("flowers", 0, [0.87, 0.19, 0.46, 0.55]),
    ]
    .into_iter()
    .map(|(name, tint, average)| Material {
        key: json!([format!("synthetic:{name}"), {}]).to_string(),
        name: name.into(),
        texture: format!("synthetic:{name}"),
        tint,
        approximate: false,
        uv: [0.; 4],
        average,
    })
    .collect()
}

fn fixture_region(rx: i32, rz: i32) -> SurfaceRegion {
    let mut r = SurfaceRegion::empty(rx, rz);
    for z in 0..256 {
        for x in 0..256 {
            let (wx, wz) = (rx * 256 + x, rz * 256 + z);
            let i = (z * 256 + x) as usize;
            if (-448..-400).contains(&wx) && (256..320).contains(&wz) {
                continue;
            }
            if (-320..-272).contains(&wx) && (256..320).contains(&wz) {
                r.coverage[i] = 2;
                continue;
            }
            // Integer terrain is reproducible across hosts and crosses tile/region boundaries.
            let coast = -180 + (wz.div_euclid(48).rem_euclid(6) - 3).abs() * 24;
            let ocean = wx < coast;
            let ridge = (210 - ((wx - 200).abs() + (wz + 80).abs()) / 2).max(0);
            let terrace = (wx + wz).div_euclid(40).rem_euclid(5) * 3;
            let h = if ocean {
                24
            } else {
                25 + (wx - coast).min(160) / 12 + ridge + terrace
            };
            r.coverage[i] = 1;
            r.heights[i] = (h * 16) as i16;
            r.biomes[i] =
                (wx.div_euclid(96).rem_euclid(3) + wz.div_euclid(80).rem_euclid(4) * 3) as u32;
            r.tints[i] = match r.biomes[i] % 3 {
                0 => 0x70af50,
                1 => 0x9aba62,
                _ => 0x4f995d,
            };
            r.materials[i] = if ocean {
                4
            } else if wx - coast < 24 {
                3
            } else if ridge > 100 {
                2
            } else {
                1
            };
            r.supports[i] = if ocean { 3 } else { r.materials[i] };
            r.water_depth[i] = if ocean {
                (1 + (coast - wx) / 8).min(48) as u32
            } else {
                0
            };
            r.support_heights[i] = r.heights[i] - (r.water_depth[i] * 16) as i16;
            if !ocean
                && ((wx.div_euclid(24) + wz.div_euclid(24)).rem_euclid(11) == 0 || ridge > 130)
            {
                r.overlays[i] = if ridge > 130 { 5 } else { 7 };
                r.overlay_heights[i] = r.heights[i] + 2;
            }
            if (320..400).contains(&wx) && (-384..-304).contains(&wz) {
                r.materials[i] = 6;
                r.heights[i] += 96;
            }
            if (32..80).contains(&wx) && (256..304).contains(&wz) {
                r.heights[i] = -192 + (wx - 32) as i16;
                r.support_heights[i] = r.heights[i] - 16;
                r.overlays[i] = 0;
                r.overlay_heights[i] = i16::MIN;
            }
            if wx == 127 && wz == -129 {
                r.heights[i] = 4800;
            }
        }
    }
    r
}

/// Deterministic, entirely synthetic 1024-square coastline, relief and coverage
/// fixture. Keeps a region-only source manifest alongside the prepared LOD tree.
pub fn create_lod_fixture(output: &Path) -> Result<LodManifest> {
    Ok(create_lod_fixture_with_diagnostics(output)?.0)
}

/// Fixture diagnostics are returned separately so timings never affect hashes.
pub fn create_lod_fixture_with_diagnostics(output: &Path) -> Result<(LodManifest, Value)> {
    create_lod_fixture_with_options(output, LodFixtureOptions::default())
}

/// The optional legacy height field is restricted to this fixed synthetic fixture.
/// General surface-manifest conversion continues to use bounded height pages.
pub fn create_lod_fixture_with_options(
    output: &Path,
    options: LodFixtureOptions,
) -> Result<(LodManifest, Value)> {
    let started = Instant::now();
    let source = output.join("source");
    let mut materials = fixture_materials();
    let atlas = crate::app::assets::synthetic(&source, &mut materials)?;
    let mut refs = Vec::new();
    let mut range = [i16::MAX, i16::MIN];
    let mut legacy_heights = options
        .legacy_reference
        .then(|| vec![0u8; FIXTURE_HEIGHT_BYTES]);
    for rz in -2..2 {
        for rx in -2..2 {
            let r = fixture_region(rx, rz);
            let raw = encode_live_region(&r)?;
            let bytes = zstd::encode_all(raw.as_slice(), 3)?;
            ensure!(
                decode_region(&decompress(&bytes, MAX_DECOMPRESSED)?)? == r,
                "fixture region verification"
            );
            let reference = object(&source, "zst", &bytes)?;
            let mut columns = 0;
            for (i, (h, c)) in r.heights.iter().zip(&r.coverage).enumerate() {
                if *c == 1 {
                    range[0] = range[0].min(*h);
                    range[1] = range[1].max(*h);
                }
                if *c != 0 {
                    columns += 1;
                }
                if let Some(heights) = &mut legacy_heights {
                    let x = (rx + 2) as usize * 256 + i % 256;
                    let z = (rz + 2) as usize * 256 + i / 256;
                    let offset = (z * FIXTURE_SIDE + x) * 2;
                    let height = if *c == 1 {
                        *h
                    } else {
                        surface_core::MISSING_HEIGHT
                    };
                    heights[offset..offset + 2].copy_from_slice(&height.to_le_bytes());
                }
            }
            refs.push(RegionRef {
                rx,
                rz,
                url: reference.url,
                sha256: reference.sha256,
                bytes: reference.bytes,
                columns,
            });
        }
    }
    let legacy_height = if let Some(raw) = legacy_heights {
        let compressed = zstd::encode_all(raw.as_slice(), 3)?;
        ensure!(
            decompress(&compressed, FIXTURE_HEIGHT_BYTES)? == raw,
            "legacy fixture height verification failed"
        );
        Some(object(&source, "zst", &compressed)?)
    } else {
        None
    };
    let manifest = MapManifest {
        format_version: 1,
        name: "Native LOD Coastline".into(),
        bounds: [-512, -512, 512, 512],
        spawn: [64, 64, 64],
        source_sha256: hash(b"surface-lod-synthetic-coastline-v1"),
        catalog_version: hash(&serde_json::to_vec(&materials)?),
        materials,
        atlas,
        regions: refs,
        heights: legacy_height
            .as_ref()
            .map(|h| h.url.clone())
            .unwrap_or_default(),
        heights_sha256: legacy_height
            .as_ref()
            .map(|h| h.sha256.clone())
            .unwrap_or_default(),
        height_range: range,
        approximations: vec![
            "Synthetic procedural terrain and custom solid textures; no world or Minecraft assets"
                .into(),
            if options.legacy_reference {
                "Legacy reference height field uses the same synthetic columns".into()
            } else {
                "Region-only source; prepare-lod supplies height pages".into()
            },
        ],
    };
    atomic_write(
        &source.join("manifest.json"),
        &serde_json::to_vec_pretty(&manifest)?,
    )?;
    let conversion_started = Instant::now();
    let lod = prepare_lod(&source.join("manifest.json"), output)?;
    let conversion_elapsed_ms = conversion_started.elapsed().as_secs_f64() * 1000.;
    let mut diagnostics = fixture_diagnostics(output, &lod)?;
    diagnostics["source_regions"] = json!(manifest.regions.len());
    if let Some(height) = legacy_height {
        diagnostics["legacy_reference"] = json!({
            "manifest":"source/manifest.json","width":FIXTURE_SIDE,"height":FIXTURE_SIDE,
            "decoded_bytes":FIXTURE_HEIGHT_BYTES,"compressed_bytes":height.bytes,
            "height_sha256":height.sha256
        });
    }
    diagnostics["conversion_elapsed_ms"] = json!(conversion_elapsed_ms);
    diagnostics["elapsed_ms"] = json!(started.elapsed().as_secs_f64() * 1000.);
    Ok((lod, diagnostics))
}

#[derive(Default)]
struct FixtureStats {
    nodes: [usize; MAX_LEVEL as usize + 1],
    data_bytes: [usize; MAX_LEVEL as usize + 1],
    height_bytes: [usize; MAX_LEVEL as usize + 1],
    index_bytes: usize,
    chunk_refs: usize,
    chunk_bytes: usize,
}

impl FixtureStats {
    // Depth-first traversal holds one small index per level, never all pages.
    fn visit(&mut self, output: &Path, reference: &NodeRef) -> Result<()> {
        let node = LodNode::decode(&read_object(output, &reference.index, MAX_NODE_BYTES)?)?;
        ensure!(node.key == reference.key, "diagnostic node key mismatch");
        let level = node.key.level as usize;
        self.nodes[level] += 1;
        self.data_bytes[level] += node.data.bytes;
        self.height_bytes[level] += node.height.bytes;
        self.index_bytes += reference.index.bytes;
        self.chunk_refs += node.chunks.len();
        self.chunk_bytes += node.chunks.iter().map(|c| c.object.bytes).sum::<usize>();
        for child in &node.children {
            self.visit(output, child)?;
        }
        Ok(())
    }
}

fn fixture_diagnostics(output: &Path, manifest: &LodManifest) -> Result<Value> {
    let mut stats = FixtureStats::default();
    for root in &manifest.roots {
        stats.visit(output, root)?;
    }
    let nodes = stats.nodes.iter().sum::<usize>();
    let catalog_bytes = manifest
        .catalog
        .iter()
        .map(|page| page.object.bytes)
        .sum::<usize>();
    let descriptor_bytes = manifest.encode()?.len();
    let summary_bytes = stats.data_bytes[1..].iter().sum::<usize>();
    let height_bytes = stats.height_bytes.iter().sum::<usize>();
    let total = descriptor_bytes
        + catalog_bytes
        + manifest.atlas.bytes
        + stats.index_bytes
        + stats.data_bytes[0]
        + summary_bytes
        + height_bytes
        + stats.chunk_bytes;
    let levels = (0..=MAX_LEVEL as usize).filter(|level| stats.nodes[*level] > 0).map(|level| {
        json!({"level":level,"nodes":stats.nodes[level],"data_bytes":stats.data_bytes[level],"height_bytes":stats.height_bytes[level]})
    }).collect::<Vec<_>>();
    Ok(json!({
        "schema_version":1,"root_count":manifest.roots.len(),"node_count":nodes,
        "detail_tiles":stats.nodes[0],"summary_tiles":nodes-stats.nodes[0],"height_pages":nodes,
        "catalog_pages":manifest.catalog.len(),"material_count":manifest.material_count,
        "referenced_objects":nodes*3+manifest.catalog.len()+1+stats.chunk_refs,
        "chunk_references":stats.chunk_refs,"levels":levels,
        "referenced_bytes":{"descriptor":descriptor_bytes,"node_indexes":stats.index_bytes,
            "detail":stats.data_bytes[0],"summary":summary_bytes,"height":height_bytes,
            "atlas":manifest.atlas.bytes,"catalog":catalog_bytes,"chunks":stats.chunk_bytes,"total":total}
    }))
}

#[cfg(test)]
mod tests;
