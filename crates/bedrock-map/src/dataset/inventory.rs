use super::{
    MAX_MANIFEST, ValidatedLod, digest,
    lod::{Reader, inside},
    read_bounded, read_relative, validate_atlas, validate_legacy, validate_lod,
};
use anyhow::{Context, Result, ensure};
use serde::Deserialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};
use surface_core::{
    CELLS, MAX_DECOMPRESSED, MISSING_HEIGHT, MapManifest, Material, SIDE, decode_region,
    decompress_with_window_limit,
    lod::{MAX_ATLAS_BYTES, MAX_TILE_BYTES, ObjectRef, validate_bounds, validate_materials},
    terrain::{RULES_VERSION, SurfaceChunk},
};

/// Verify all referenced files and return the exact permitted relative paths.
/// Supports legacy snapshots and v2 regional streams, with optional lod.json.
/// Callers must compare this closure against the directory inventory to reject
/// unlisted files. The legacy MapManifest-returning validate API is unchanged.
pub fn validate_inventory(root: &Path) -> Result<BTreeSet<PathBuf>> {
    inventory(root)
        .map_err(|e| anyhow::anyhow!("E_RESOURCE_MISMATCH: invalid dataset inventory: {e:#}"))
}

fn inventory(root: &Path) -> Result<BTreeSet<PathBuf>> {
    let metadata = fs::symlink_metadata(root)?;
    ensure!(
        metadata.is_dir() && !metadata.file_type().is_symlink(),
        "unsafe dataset root"
    );
    let bytes = read_bounded(&root.join("manifest.json"), 64 * 1024 * 1024)?;
    #[derive(Deserialize)]
    struct Format {
        format_version: u32,
    }
    let format: Format = serde_json::from_slice(&bytes)?;
    let lod = validate_lod(root)?;
    let mut files = match format.format_version {
        1 => {
            ensure!(
                bytes.len() as u64 <= MAX_MANIFEST,
                "snapshot manifest byte limit"
            );
            drop(bytes);
            let manifest = validate_legacy(root)?;
            if let Some(lod) = &lod {
                match_snapshot(root, &manifest, lod)?;
            }
            let mut files = BTreeSet::from([
                PathBuf::from(&manifest.atlas),
                PathBuf::from(&manifest.heights),
            ]);
            files.extend(manifest.regions.into_iter().map(|r| PathBuf::from(r.url)));
            files
        }
        2 => {
            let manifest: StreamManifest = serde_json::from_slice(&bytes)?;
            drop(bytes);
            let (files, catalog_hash) = validate_stream(root, &manifest)?;
            if let Some(lod) = &lod {
                ensure!(
                    lod.root.bounds == manifest.bounds
                        && lod.root.spawn == manifest.spawn
                        && lod.root.name == manifest.name
                        && lod.root.source_sha256 == manifest.source_sha256
                        && lod.root.world_id.as_deref() == Some(&manifest.world_id)
                        && lod.root.generation == manifest.generation,
                    "stream/LOD identity mismatch"
                );
                // Live LOD revisions and legacy stream revisions are independent counters.
                ensure!(
                    lod.catalog_hash == catalog_hash && lod.root.atlas == manifest.atlas,
                    "stream/LOD appearance mismatch"
                );
            }
            files
        }
        _ => anyhow::bail!("unsupported dataset format"),
    };
    files.insert(PathBuf::from("manifest.json"));
    if let Some(lod) = lod {
        files.extend(lod.files);
    }
    for notice in ["assets/NOTICE.txt", "assets/MOJANG-LICENSE.md"] {
        match fs::symlink_metadata(root.join(notice)) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            result => {
                result?;
            }
        }
        read_relative(root, notice, 1024 * 1024)?;
        files.insert(PathBuf::from(notice));
    }
    Ok(files)
}

pub(super) fn match_snapshot(
    root: &Path,
    manifest: &MapManifest,
    validated: &ValidatedLod,
) -> Result<()> {
    let lod = &validated.root;
    let source = &manifest.source_sha256;
    let fingerprint = if source.len() == 64 && source.bytes().all(|b| b.is_ascii_hexdigit()) {
        source.to_ascii_lowercase()
    } else {
        digest(&read_bounded(&root.join("manifest.json"), MAX_MANIFEST)?)
    };
    ensure!(
        lod.source_sha256 == fingerprint
            && lod.bounds == manifest.bounds
            && lod.spawn == manifest.spawn
            && lod.name == manifest.name
            && lod.material_count == manifest.materials.len()
            && lod.world_id.is_none(),
        "E_RESOURCE_MISMATCH: snapshot/LOD identity mismatch"
    );
    ensure!(
        manifest.catalog_version == validated.catalog_hash,
        "E_RESOURCE_MISMATCH: snapshot/LOD catalog mismatch"
    );
    ensure!(
        digest(&read_relative(
            root,
            &manifest.atlas,
            MAX_ATLAS_BYTES as u64
        )?) == lod.atlas.sha256,
        "E_RESOURCE_MISMATCH: snapshot/LOD atlas mismatch"
    );
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StreamManifest {
    format_version: u32,
    rules_version: u32,
    name: String,
    world_id: String,
    generation: String,
    revision: u64,
    source_sha256: String,
    bounds: [i32; 4],
    spawn: [i32; 3],
    height_range: [i16; 2],
    atlas: ObjectRef,
    catalog: ObjectRef,
    regions: Vec<StreamRegion>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StreamRegion {
    rx: i32,
    rz: i32,
    index: ObjectRef,
    surface: Option<ObjectRef>,
    heights: Option<ObjectRef>,
    columns: Option<usize>,
    height_range: Option<[i16; 2]>,
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

fn validate_stream(root: &Path, manifest: &StreamManifest) -> Result<(BTreeSet<PathBuf>, String)> {
    ensure!(
        manifest.format_version == 2 && manifest.rules_version == RULES_VERSION,
        "unsupported stream version"
    );
    validate_bounds(manifest.bounds)?;
    ensure!(
        inside(manifest.bounds, manifest.spawn[0], manifest.spawn[2]),
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
    let mut reader = Reader::new(root);
    validate_atlas(&reader.read(&manifest.atlas, MAX_ATLAS_BYTES)?)?;
    let materials: Vec<Material> =
        serde_json::from_slice(&reader.read(&manifest.catalog, 64 * 1024 * 1024)?)?;
    validate_materials(&materials)?;
    let catalog_hash = digest(&serde_json::to_vec(&materials)?);
    let mut seen = BTreeSet::new();
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
        let index: RegionIndex =
            serde_json::from_slice(&reader.read(&reference.index, MAX_TILE_BYTES)?)?;
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
        let packed = reader.read(&index.surface, MAX_DECOMPRESSED)?;
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
            &reader.read(&index.heights, CELLS * 2 + 1024)?,
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
            let chunk = reader.chunk(object, cx, cz, materials.len())?;
            ensure!(
                chunk == SurfaceChunk::from_region(&region, cx, cz)?,
                "stream chunk/surface mismatch"
            );
        }
    }
    Ok((reader.paths(), catalog_hash))
}
