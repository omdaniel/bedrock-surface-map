use anyhow::{Context, Result, ensure};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeSet, HashSet},
    fs,
    io::Read,
    path::{Path, PathBuf},
};
use surface_core::{
    CELLS, MAX_DECOMPRESSED, MISSING_HEIGHT, MapManifest, SIDE, VERSION, decode_region, decompress,
};

use crate::resources::safe_relative;

mod lod;
pub use lod::{ValidatedLod, validate_lod};

#[cfg(test)]
mod tests;

const MAX_MANIFEST: u64 = 16 * 1024 * 1024;
const MAX_REGION: u64 = 16 * 1024 * 1024;
const MAX_ATLAS: u64 = 64 * 1024 * 1024;
const MAX_HEIGHTS: usize = 32 * 1024 * 1024;

fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>> {
    let metadata = fs::symlink_metadata(path)?;
    ensure!(
        metadata.is_file() && !metadata.file_type().is_symlink() && metadata.len() <= limit,
        "E_RESOURCE_MISMATCH: missing, unsafe, or oversized dataset object: {}",
        path.display()
    );
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(limit + 1)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= limit,
        "E_RESOURCE_MISMATCH: dataset object grew beyond limit"
    );
    Ok(bytes)
}

fn object(root: &Path, reference: &str, limit: u64) -> Result<Vec<u8>> {
    let relative = safe_relative(reference)?;
    let path = root.join(relative);
    ensure!(
        path.parent().is_some_and(|parent| parent != root),
        "E_RESOURCE_MISMATCH: object must be in a dataset subdirectory"
    );
    read_relative(root, reference, limit)
}

fn read_relative(root: &Path, reference: &str, limit: u64) -> Result<Vec<u8>> {
    let relative = safe_relative(reference)?;
    // Reject symlinks in every path component, not just the final file.
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component);
        let metadata = fs::symlink_metadata(&current)?;
        ensure!(
            !metadata.file_type().is_symlink(),
            "E_RESOURCE_MISMATCH: dataset symlink"
        );
    }
    read_bounded(&root.join(relative), limit)
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn validate_atlas(atlas: &[u8]) -> Result<()> {
    ensure!(
        atlas.len() >= 24 && atlas[..8] == [137, 80, 78, 71, 13, 10, 26, 10],
        "E_RESOURCE_MISMATCH: atlas is not a PNG"
    );
    let width = u32::from_be_bytes(atlas[16..20].try_into()?);
    let height = u32::from_be_bytes(atlas[20..24].try_into()?);
    ensure!(
        width > 0
            && height > 0
            && width <= 8192
            && height <= 8192
            && u64::from(width) * u64::from(height) <= 8 * 1024 * 1024,
        "E_RESOURCE_MISMATCH: invalid atlas dimensions"
    );
    let image = image::load_from_memory_with_format(atlas, image::ImageFormat::Png)
        .context("E_RESOURCE_MISMATCH: atlas is not a valid PNG")?;
    ensure!(
        image.width() == width && image.height() == height,
        "E_RESOURCE_MISMATCH: invalid atlas dimensions"
    );
    Ok(())
}

pub struct Inventory {
    pub source_sha256: String,
    pub legacy: bool,
    pub files: BTreeSet<PathBuf>,
    pub lod_identity: Option<(String, String)>,
}

/// Verify the exact referenced closure, accepting a legacy snapshot, an optional
/// matching LOD companion, or standalone output from surface-map prepare-lod.
/// Private/unreferenced input files are never part of the returned inventory.
pub fn inventory(root: &Path) -> Result<Inventory> {
    let metadata = fs::symlink_metadata(root)?;
    ensure!(
        metadata.is_dir() && !metadata.file_type().is_symlink(),
        "E_RESOURCE_MISMATCH: unsafe dataset root"
    );
    let lod = validate_lod(root)?;
    let legacy = match fs::symlink_metadata(root.join("manifest.json")) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        result => {
            result?;
            true
        }
    };
    let mut files = BTreeSet::new();
    let source_sha256 = if legacy {
        let manifest = validate(root)?;
        let source = &manifest.source_sha256;
        let fingerprint = if source.len() == 64 && source.bytes().all(|b| b.is_ascii_hexdigit()) {
            source.to_ascii_lowercase()
        } else {
            digest(&read_bounded(&root.join("manifest.json"), MAX_MANIFEST)?)
        };
        if let Some(lod) = &lod {
            ensure!(
                lod.root.source_sha256 == fingerprint
                    && lod.root.bounds == manifest.bounds
                    && lod.root.spawn == manifest.spawn
                    && lod.root.name == manifest.name
                    && lod.root.material_count == manifest.materials.len()
                    && lod.root.world_id.is_none()
                    && lod.catalog_hash == manifest.catalog_version
                    && lod.root.atlas.sha256 == digest(&object(root, &manifest.atlas, MAX_ATLAS)?),
                "E_RESOURCE_MISMATCH: snapshot/LOD identity or appearance mismatch"
            );
        }
        files.extend([
            PathBuf::from("manifest.json"),
            PathBuf::from(manifest.atlas),
            PathBuf::from(manifest.heights),
        ]);
        files.extend(manifest.regions.into_iter().map(|r| PathBuf::from(r.url)));
        fingerprint
    } else {
        lod.as_ref()
            .context("E_RESOURCE_MISMATCH: dataset has no manifest or LOD descriptor")?
            .root
            .source_sha256
            .clone()
    };
    let lod_identity = lod.as_ref().and_then(|lod| {
        lod.root
            .world_id
            .clone()
            .map(|world| (world, lod.root.generation.clone()))
    });
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
    Ok(Inventory {
        source_sha256,
        legacy,
        files,
        lod_identity,
    })
}

/// App-relative URLs preserve both root and subpath mounts. Call after inventory
/// validation; no origin, query-string or browser request chooses a file path.
pub fn viewer_binding(root: &Path, dataset: &str) -> Result<serde_json::Value> {
    let mut value = serde_json::json!({});
    if root.join("manifest.json").is_file() {
        value["map"] = format!("maps/{dataset}/manifest.json").into();
    }
    if root.join("lod.json").is_file() {
        let lod = surface_core::lod::LodManifest::decode(&read_bounded(
            &root.join("lod.json"),
            surface_core::lod::MAX_DESCRIPTOR_BYTES as u64,
        )?)?;
        value["lod_url"] = format!("maps/{dataset}/lod.json").into();
        if let Some(world) = lod.world_id {
            value["lod_identity"] =
                serde_json::json!({"world_id":world,"generation":lod.generation});
        }
    }
    Ok(value)
}

pub fn validate(root: &Path) -> Result<MapManifest> {
    let manifest: MapManifest =
        serde_json::from_slice(&read_bounded(&root.join("manifest.json"), MAX_MANIFEST)?)
            .context("E_RESOURCE_MISMATCH: invalid dataset manifest")?;
    ensure!(
        manifest.format_version == VERSION,
        "E_RESOURCE_MISMATCH: unsupported snapshot format"
    );
    ensure!(
        !manifest.heights.is_empty() && !manifest.regions.is_empty(),
        "E_RESOURCE_MISMATCH: region-only repair export is not a complete snapshot"
    );
    ensure!(
        !manifest.materials.is_empty() && manifest.materials.len() <= 65_536,
        "E_RESOURCE_MISMATCH: invalid material catalog"
    );
    ensure!(
        digest(&serde_json::to_vec(&manifest.materials)?) == manifest.catalog_version,
        "E_RESOURCE_MISMATCH: material catalog hash mismatch"
    );
    for material in &manifest.materials {
        ensure!(
            !material.key.is_empty()
                && material
                    .uv
                    .iter()
                    .chain(material.average.iter())
                    .all(|v| v.is_finite()),
            "E_RESOURCE_MISMATCH: invalid material"
        );
        ensure!(
            material.uv.iter().all(|v| (0.0..=1.0).contains(v)),
            "E_RESOURCE_MISMATCH: invalid atlas UV"
        );
    }
    let [min_x, min_z, max_x, max_z] = manifest.bounds;
    let width = i64::from(max_x) - i64::from(min_x);
    let height = i64::from(max_z) - i64::from(min_z);
    ensure!(
        width > 0
            && height > 0
            && width % SIDE as i64 == 0
            && height % SIDE as i64 == 0
            && min_x % SIDE as i32 == 0
            && min_z % SIDE as i32 == 0
            && width
                .checked_mul(height)
                .is_some_and(|n| n <= 16 * 1024 * 1024),
        "E_RESOURCE_MISMATCH: invalid snapshot bounds"
    );
    ensure!(
        manifest.spawn[0] >= min_x
            && manifest.spawn[0] < max_x
            && manifest.spawn[2] >= min_z
            && manifest.spawn[2] < max_z,
        "E_RESOURCE_MISMATCH: spawn is outside mapped bounds"
    );
    ensure!(
        manifest.height_range[0] <= manifest.height_range[1],
        "E_RESOURCE_MISMATCH: invalid height range"
    );
    ensure!(
        manifest.regions.len() <= (width * height / CELLS as i64) as usize,
        "E_RESOURCE_MISMATCH: too many regions"
    );
    let atlas = object(root, &manifest.atlas, MAX_ATLAS)?;
    validate_atlas(&atlas)?;
    let packed_heights = object(root, &manifest.heights, MAX_HEIGHTS as u64)?;
    ensure!(
        digest(&packed_heights) == manifest.heights_sha256,
        "E_RESOURCE_MISMATCH: height checksum mismatch"
    );
    let raw_heights = decompress(&packed_heights, MAX_HEIGHTS)?;
    ensure!(
        raw_heights.len() == (width * height * 2) as usize,
        "E_RESOURCE_MISMATCH: height field size mismatch"
    );
    let mut expected = vec![MISSING_HEIGHT; (width * height) as usize];
    let mut seen = HashSet::new();
    let mut range = [i16::MAX, i16::MIN];
    for reference in &manifest.regions {
        ensure!(
            seen.insert((reference.rx, reference.rz)),
            "E_RESOURCE_MISMATCH: duplicate region"
        );
        let x = i64::from(reference.rx) * SIDE as i64;
        let z = i64::from(reference.rz) * SIDE as i64;
        ensure!(
            x >= i64::from(min_x)
                && z >= i64::from(min_z)
                && x + SIDE as i64 <= i64::from(max_x)
                && z + SIDE as i64 <= i64::from(max_z),
            "E_RESOURCE_MISMATCH: region outside bounds"
        );
        ensure!(
            reference.bytes > 0
                && reference.bytes as u64 <= MAX_REGION
                && reference.columns <= CELLS,
            "E_RESOURCE_MISMATCH: invalid region metadata"
        );
        let packed = object(root, &reference.url, MAX_REGION)?;
        ensure!(
            packed.len() == reference.bytes && digest(&packed) == reference.sha256,
            "E_RESOURCE_MISMATCH: region hash or size mismatch"
        );
        let region = decode_region(&decompress(&packed, MAX_DECOMPRESSED)?)
            .context("E_RESOURCE_MISMATCH: invalid region")?;
        ensure!(
            (region.rx, region.rz) == (reference.rx, reference.rz),
            "E_RESOURCE_MISMATCH: region coordinates mismatch"
        );
        let mut columns = 0;
        for index in 0..CELLS {
            if region.coverage[index] == 0 {
                ensure!(
                    region.heights[index] == MISSING_HEIGHT,
                    "E_RESOURCE_MISMATCH: uncovered column has height"
                );
                continue;
            }
            columns += 1;
            ensure!(
                (region.materials[index] as usize) < manifest.materials.len()
                    && (region.overlays[index] as usize) < manifest.materials.len()
                    && (region.supports[index] as usize) < manifest.materials.len(),
                "E_RESOURCE_MISMATCH: invalid material reference"
            );
            let value = region.heights[index];
            ensure!(
                value != MISSING_HEIGHT,
                "E_RESOURCE_MISMATCH: covered column missing height"
            );
            range[0] = range[0].min(value);
            range[1] = range[1].max(value);
            let gx = (x - i64::from(min_x)) as usize + index % SIDE;
            let gz = (z - i64::from(min_z)) as usize + index / SIDE;
            expected[gz * width as usize + gx] = value;
        }
        ensure!(
            columns == reference.columns,
            "E_RESOURCE_MISMATCH: region column count mismatch"
        );
    }
    ensure!(
        range == manifest.height_range,
        "E_RESOURCE_MISMATCH: height range mismatch"
    );
    ensure!(
        expected
            .iter()
            .zip(raw_heights.chunks_exact(2))
            .all(|(expected, bytes)| *expected == i16::from_le_bytes([bytes[0], bytes[1]])),
        "E_RESOURCE_MISMATCH: region and height field disagree"
    );
    Ok(manifest)
}
