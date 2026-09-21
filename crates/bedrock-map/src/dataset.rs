use anyhow::{Context, Result, ensure};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, fs, path::Path};
use surface_core::{
    CELLS, MAX_DECOMPRESSED, MISSING_HEIGHT, MapManifest, SIDE, VERSION, decode_region, decompress,
};

use crate::resources::safe_relative;

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
    Ok(fs::read(path)?)
}

fn object(root: &Path, reference: &str, limit: u64) -> Result<Vec<u8>> {
    let relative = safe_relative(reference)?;
    let path = root.join(relative);
    ensure!(
        path.parent().is_some_and(|parent| parent != root),
        "E_RESOURCE_MISMATCH: object must be in a dataset subdirectory"
    );
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
    read_bounded(&path, limit)
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
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
        manifest.height_range[0] <= manifest.height_range[1],
        "E_RESOURCE_MISMATCH: invalid height range"
    );
    ensure!(
        manifest.regions.len() <= (width * height / CELLS as i64) as usize,
        "E_RESOURCE_MISMATCH: too many regions"
    );
    let atlas = object(root, &manifest.atlas, MAX_ATLAS)?;
    ensure!(
        atlas.len() >= 24 && atlas[..8] == [137, 80, 78, 71, 13, 10, 26, 10],
        "E_RESOURCE_MISMATCH: atlas is not a PNG"
    );
    let atlas_width = u32::from_be_bytes(atlas[16..20].try_into()?);
    let atlas_height = u32::from_be_bytes(atlas[20..24].try_into()?);
    ensure!(
        atlas_width > 0
            && atlas_height > 0
            && atlas_width <= 8192
            && atlas_height <= 8192
            && u64::from(atlas_width) * u64::from(atlas_height) <= 8 * 1024 * 1024,
        "E_RESOURCE_MISMATCH: invalid atlas dimensions"
    );
    let image = image::load_from_memory_with_format(&atlas, image::ImageFormat::Png)
        .context("E_RESOURCE_MISMATCH: atlas is not a valid PNG")?;
    ensure!(
        image.width() == atlas_width && image.height() == atlas_height,
        "E_RESOURCE_MISMATCH: invalid atlas dimensions"
    );
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
