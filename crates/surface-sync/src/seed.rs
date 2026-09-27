//! Bounded regional snapshot input shared by native registration and seeding.
use crate::store::hash;
use anyhow::{Context, Result, ensure};
use serde::Deserialize;
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    path::{Component, Path},
};
use surface_core::{
    CELLS, MAX_DECOMPRESSED, MISSING_HEIGHT, MapManifest, Material, SIDE, SurfaceRegion,
    decode_region, decompress_with_window_limit,
    lod::{MAX_ATLAS_BYTES, MAX_TILE_BYTES, ObjectRef, validate_bounds, validate_materials},
    terrain::{RULES_VERSION, SurfaceChunk},
};

pub const MAX_SOURCE_JSON: usize = 64 * 1024 * 1024;

fn read_file(root: &Path, url: &str, limit: usize) -> Result<Vec<u8>> {
    ensure!(!url.is_empty(), "empty snapshot asset path");
    let root_metadata = fs::symlink_metadata(root)?;
    ensure!(
        root_metadata.is_dir() && !root_metadata.file_type().is_symlink(),
        "unsafe snapshot root"
    );
    let mut path = root.to_path_buf();
    for component in Path::new(url).components() {
        ensure!(
            matches!(component, Component::Normal(_)),
            "unsafe snapshot asset path"
        );
        path.push(component);
        ensure!(
            !fs::symlink_metadata(&path)?.file_type().is_symlink(),
            "snapshot asset symlink"
        );
    }
    let metadata = fs::symlink_metadata(&path)?;
    ensure!(
        metadata.is_file() && metadata.len() <= limit as u64,
        "oversized snapshot asset"
    );
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= limit, "snapshot asset grew beyond limit");
    Ok(bytes)
}

fn read_object(root: &Path, reference: &ObjectRef, limit: usize) -> Result<Vec<u8>> {
    reference.validate(limit)?;
    let bytes = read_file(root, &reference.url, reference.bytes)?;
    ensure!(
        bytes.len() == reference.bytes && hash(&bytes) == reference.sha256,
        "snapshot object length/hash mismatch"
    );
    Ok(bytes)
}

pub(crate) struct Snapshot {
    pub name: String,
    pub spawn: [i32; 3],
    pub bounds: [i32; 4],
    pub source_sha256: String,
    pub identity: Option<(String, String)>,
    pub materials: Vec<Material>,
    pub atlas: Vec<u8>,
    regions: Vec<(i32, i32, ObjectRef)>,
    manifest_bytes: Vec<u8>,
}

impl Snapshot {
    pub fn load(root: &Path) -> Result<Self> {
        let bytes = read_file(root, "manifest.json", MAX_SOURCE_JSON)?;
        #[derive(Deserialize)]
        struct Format {
            format_version: u32,
        }
        let format: Format = serde_json::from_slice(&bytes)?;
        let snapshot = match format.format_version {
            1 => {
                let manifest: MapManifest = serde_json::from_slice(&bytes)?;
                validate_bounds(manifest.bounds)?;
                let atlas = read_file(root, &manifest.atlas, MAX_ATLAS_BYTES)?;
                Self {
                    name: manifest.name,
                    spawn: manifest.spawn,
                    bounds: manifest.bounds,
                    source_sha256: manifest.source_sha256,
                    identity: None,
                    materials: manifest.materials,
                    atlas,
                    regions: manifest
                        .regions
                        .into_iter()
                        .map(|r| {
                            (
                                r.rx,
                                r.rz,
                                ObjectRef {
                                    url: r.url,
                                    sha256: r.sha256,
                                    bytes: r.bytes,
                                },
                            )
                        })
                        .collect(),
                    manifest_bytes: bytes,
                }
            }
            2 => {
                let manifest: StreamManifest = serde_json::from_slice(&bytes)?;
                let materials = validate_stream(&manifest, |r, limit| read_object(root, r, limit))?;
                let mut regions = Vec::with_capacity(manifest.regions.len());
                for reference in &manifest.regions {
                    let index: RegionIndex = serde_json::from_slice(&read_object(
                        root,
                        &reference.index,
                        MAX_TILE_BYTES,
                    )?)?;
                    regions.push((reference.rx, reference.rz, index.surface));
                }
                let atlas = read_object(root, &manifest.atlas, MAX_ATLAS_BYTES)?;
                Self {
                    name: manifest.name,
                    spawn: manifest.spawn,
                    bounds: manifest.bounds,
                    source_sha256: manifest.source_sha256,
                    identity: Some((manifest.world_id, manifest.generation)),
                    materials,
                    atlas,
                    regions,
                    manifest_bytes: bytes,
                }
            }
            _ => anyhow::bail!("seed requires a supported offline snapshot"),
        };
        ensure!(
            !snapshot.materials.is_empty(),
            "empty seed material catalog"
        );
        let mut seen = std::collections::BTreeSet::new();
        for (rx, rz, _) in &snapshot.regions {
            ensure!(
                (-32768..32768).contains(rx) && (-32768..32768).contains(rz),
                "seed region coordinate limit"
            );
            ensure!(seen.insert((*rx, *rz)), "duplicate seed region");
        }
        Ok(snapshot)
    }

    pub fn regions(&self) -> usize {
        self.regions.len()
    }

    pub fn region(&self, root: &Path, index: usize) -> Result<SurfaceRegion> {
        let (rx, rz, reference) = &self.regions[index];
        let packed = read_object(root, reference, MAX_DECOMPRESSED)?;
        let region = decode_region(&decompress_with_window_limit(
            &packed,
            MAX_DECOMPRESSED,
            MAX_DECOMPRESSED as u64,
        )?)?;
        ensure!(
            (region.rx, region.rz) == (*rx, *rz),
            "region coordinate mismatch"
        );
        Ok(region)
    }

    pub fn verify_unchanged(&self, root: &Path) -> Result<()> {
        ensure!(
            read_file(root, "manifest.json", MAX_SOURCE_JSON)? == self.manifest_bytes,
            "snapshot manifest changed during seed"
        );
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StreamManifest {
    pub format_version: u32,
    pub rules_version: u32,
    pub name: String,
    pub world_id: String,
    pub generation: String,
    pub revision: u64,
    pub source_sha256: String,
    pub bounds: [i32; 4],
    pub spawn: [i32; 3],
    pub height_range: [i16; 2],
    pub atlas: ObjectRef,
    pub catalog: ObjectRef,
    pub regions: Vec<StreamRegion>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StreamRegion {
    pub rx: i32,
    pub rz: i32,
    pub index: ObjectRef,
    pub surface: Option<ObjectRef>,
    pub heights: Option<ObjectRef>,
    pub columns: Option<usize>,
    pub height_range: Option<[i16; 2]>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RegionIndex {
    rx: i32,
    rz: i32,
    surface: ObjectRef,
    heights: ObjectRef,
    chunks: BTreeMap<String, ObjectRef>,
    columns: usize,
    height_range: [i16; 2],
}

/// The reader must enforce safe paths, byte limits and exact object hashes.
/// Terrain validation visits one region and one chunk at a time.
pub fn validate_stream(
    manifest: &StreamManifest,
    mut read: impl FnMut(&ObjectRef, usize) -> Result<Vec<u8>>,
) -> Result<Vec<Material>> {
    ensure!(
        manifest.format_version == 2 && manifest.rules_version == RULES_VERSION,
        "unsupported stream version"
    );
    validate_bounds(manifest.bounds)?;
    ensure!(
        manifest.spawn[0] >= manifest.bounds[0]
            && manifest.spawn[0] < manifest.bounds[2]
            && manifest.spawn[2] >= manifest.bounds[1]
            && manifest.spawn[2] < manifest.bounds[3],
        "stream spawn outside bounds"
    );
    ensure!(
        !manifest.name.is_empty()
            && manifest.name.encode_utf16().count() <= 256
            && !manifest.world_id.is_empty()
            && manifest.world_id.len() <= 80
            && !manifest.generation.is_empty()
            && manifest.generation.len() <= 128
            && manifest.revision <= 9_007_199_254_740_991
            && manifest.source_sha256.len() == 64
            && manifest
                .source_sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "invalid stream identity"
    );
    ensure!(
        manifest.height_range[0] > MISSING_HEIGHT
            && manifest.height_range[0] <= manifest.height_range[1],
        "invalid stream height range"
    );
    let atlas = read(&manifest.atlas, MAX_ATLAS_BYTES)?;
    ensure!(
        atlas.starts_with(b"\x89PNG\r\n\x1a\n"),
        "stream atlas is not a PNG"
    );
    let materials: Vec<Material> =
        serde_json::from_slice(&read(&manifest.catalog, MAX_SOURCE_JSON)?)?;
    validate_materials(&materials)?;
    let mut seen = std::collections::BTreeSet::new();
    for reference in &manifest.regions {
        ensure!(
            seen.insert((reference.rx, reference.rz)),
            "duplicate stream region"
        );
        let x = i64::from(reference.rx) * SIDE as i64;
        let z = i64::from(reference.rz) * SIDE as i64;
        ensure!(
            x >= i64::from(manifest.bounds[0])
                && z >= i64::from(manifest.bounds[1])
                && x + SIDE as i64 <= i64::from(manifest.bounds[2])
                && z + SIDE as i64 <= i64::from(manifest.bounds[3]),
            "stream region outside bounds"
        );
        let index: RegionIndex = serde_json::from_slice(&read(&reference.index, MAX_TILE_BYTES)?)?;
        ensure!(
            (index.rx, index.rz) == (reference.rx, reference.rz),
            "regional index key mismatch"
        );
        ensure!(
            reference
                .surface
                .as_ref()
                .is_none_or(|r| *r == index.surface)
                && reference
                    .heights
                    .as_ref()
                    .is_none_or(|r| *r == index.heights)
                && reference.columns.is_none_or(|n| n == index.columns)
                && reference
                    .height_range
                    .is_none_or(|r| r == index.height_range),
            "stream/index metadata mismatch"
        );
        let packed = read(&index.surface, MAX_DECOMPRESSED)?;
        let region = decode_region(&decompress_with_window_limit(
            &packed,
            MAX_DECOMPRESSED,
            MAX_DECOMPRESSED as u64,
        )?)?;
        ensure!(
            (region.rx, region.rz) == (index.rx, index.rz),
            "stream surface key mismatch"
        );
        let heights = decompress_with_window_limit(
            &read(&index.heights, CELLS * 2 + 1024)?,
            CELLS * 2,
            MAX_DECOMPRESSED as u64,
        )?;
        ensure!(heights.len() == CELLS * 2, "regional height size mismatch");
        let mut columns = 0;
        let mut range = [i16::MAX, i16::MIN];
        // One region and one chunk at a time; never allocate from declared world area.
        for dz in 0..16 {
            for dx in 0..16 {
                let chunk =
                    SurfaceChunk::from_region(&region, index.rx * 16 + dx, index.rz * 16 + dz)?;
                chunk.validate(materials.len(), false)?;
                for (i, c) in chunk.columns.iter().enumerate() {
                    let j = (dz as usize * 16 + i / 16) * SIDE + dx as usize * 16 + i % 16;
                    let height = if c[0] == 1 {
                        c[1] as i16
                    } else {
                        MISSING_HEIGHT
                    };
                    ensure!(
                        i16::from_le_bytes([heights[j * 2], heights[j * 2 + 1]]) == height,
                        "stream surface/height mismatch"
                    );
                    if c[0] != 0 {
                        columns += 1;
                    }
                    if c[0] == 1 {
                        range[0] = range[0].min(height);
                        range[1] = range[1].max(height);
                    }
                }
            }
        }
        if range[0] > range[1] {
            range = [0, 0];
        }
        ensure!(
            columns == index.columns && range == index.height_range,
            "regional statistics mismatch"
        );
        ensure!(
            range[0] >= manifest.height_range[0] && range[1] <= manifest.height_range[1],
            "region outside declared height range"
        );
        ensure!(index.chunks.len() <= 256, "regional chunk count limit");
        for (key, object) in &index.chunks {
            let (cx, cz) = key
                .split_once(',')
                .context("invalid chunk coordinate key")?;
            let (cx, cz): (i32, i32) = (cx.parse()?, cz.parse()?);
            ensure!(
                *key == format!("{cx},{cz}")
                    && cx.div_euclid(16) == index.rx
                    && cz.div_euclid(16) == index.rz,
                "chunk outside regional index"
            );
            let packed = read(object, MAX_TILE_BYTES)?;
            let raw = decompress_with_window_limit(&packed, 32 * 1024, MAX_TILE_BYTES as u64)?;
            let chunk = SurfaceChunk::decode(&raw)?;
            chunk.validate(materials.len(), false)?;
            ensure!((chunk.cx, chunk.cz) == (cx, cz), "chunk key mismatch");
            ensure!(
                chunk == SurfaceChunk::from_region(&region, cx, cz)?,
                "stream chunk/surface mismatch"
            );
        }
    }
    Ok(materials)
}
