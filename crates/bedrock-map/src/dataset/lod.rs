use super::{digest, read_bounded, read_relative, validate_atlas};
use anyhow::{Result, ensure};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};
use surface_core::{Material, lod::*, terrain::SurfaceChunk};

/// A validated descriptor and its complete, verified relative-file closure,
/// including lod.json. Unreferenced files are deliberately not admitted here.
#[derive(Debug)]
pub struct ValidatedLod {
    pub root: LodManifest,
    pub files: BTreeSet<PathBuf>,
    pub(super) catalog_hash: String,
}

pub(super) struct Reader<'a> {
    pub root: &'a Path,
    files: BTreeMap<PathBuf, (usize, String)>,
}

impl<'a> Reader<'a> {
    pub fn new(root: &'a Path) -> Self {
        Self {
            root,
            files: BTreeMap::new(),
        }
    }

    pub fn read(&mut self, reference: &ObjectRef, limit: usize) -> Result<Vec<u8>> {
        reference.validate(limit)?;
        let path = PathBuf::from(&reference.url);
        let identity = (reference.bytes, reference.sha256.clone());
        if let Some(prior) = self.files.get(&path) {
            ensure!(
                prior == &identity,
                "conflicting object reference: {}",
                reference.url
            );
        }
        let bytes = read_relative(self.root, &reference.url, reference.bytes as u64)?;
        ensure!(
            bytes.len() == reference.bytes && digest(&bytes) == reference.sha256,
            "object length/hash mismatch: {}",
            reference.url
        );
        self.files.insert(path, identity);
        Ok(bytes)
    }

    pub fn paths(self) -> BTreeSet<PathBuf> {
        self.files.into_keys().collect()
    }

    pub fn chunk(
        &mut self,
        reference: &ObjectRef,
        cx: i32,
        cz: i32,
        materials: usize,
    ) -> Result<SurfaceChunk> {
        let packed = self.read(reference, MAX_TILE_BYTES)?;
        let raw =
            surface_core::decompress_with_window_limit(&packed, 32 * 1024, MAX_TILE_BYTES as u64)?;
        let chunk = SurfaceChunk::decode(&raw)?;
        chunk.validate(materials, false)?;
        ensure!((chunk.cx, chunk.cz) == (cx, cz), "chunk key mismatch");
        Ok(chunk)
    }
}

/// Validate optional lod.json using bounded object/window decoders. A missing
/// descriptor is legacy-compatible; a dangling symlink is an error, not absence.
/// Terrain memory is independent of world area: one page pair and a depth-first
/// stack of at most MAX_LEVEL + 1 nodes. Only returned file metadata grows with
/// the number of reachable objects.
pub fn validate_lod(root: &Path) -> Result<Option<ValidatedLod>> {
    match fs::symlink_metadata(root.join("lod.json")) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        result => {
            result?;
        }
    }
    validate_present(root)
        .map(Some)
        .map_err(|e| anyhow::anyhow!("E_RESOURCE_MISMATCH: invalid LOD dataset: {e:#}"))
}

fn validate_present(root: &Path) -> Result<ValidatedLod> {
    let metadata = fs::symlink_metadata(root)?;
    ensure!(
        metadata.is_dir() && !metadata.file_type().is_symlink(),
        "unsafe LOD root"
    );
    let manifest = LodManifest::decode(&read_bounded(
        &root.join("lod.json"),
        MAX_DESCRIPTOR_BYTES as u64,
    )?)?;
    ensure!(
        inside(manifest.bounds, manifest.spawn[0], manifest.spawn[2]),
        "LOD spawn outside bounds"
    );
    let mut reader = Reader::new(root);
    validate_atlas(&reader.read(&manifest.atlas, MAX_ATLAS_BYTES)?)?;
    let mut catalog = Sha256::new();
    catalog.update(b"[");
    let mut count = 0;
    for reference in &manifest.catalog {
        let page: Vec<Material> =
            serde_json::from_slice(&reader.read(&reference.object, MAX_CATALOG_PAGE_BYTES)?)?;
        ensure!(page.len() == reference.count, "catalog page count mismatch");
        validate_materials(&page)?;
        for material in page {
            if count > 0 {
                catalog.update(b",");
            }
            catalog.update(serde_json::to_vec(&material)?);
            count += 1;
        }
    }
    catalog.update(b"]");
    for reference in &manifest.roots {
        validate_node(&mut reader, &manifest, reference)?;
    }
    let mut files = reader.paths();
    files.insert(PathBuf::from("lod.json"));
    Ok(ValidatedLod {
        root: manifest,
        files,
        catalog_hash: format!("{:x}", catalog.finalize()),
    })
}

pub(super) fn inside(bounds: [i32; 4], x: i32, z: i32) -> bool {
    x >= bounds[0] && x < bounds[2] && z >= bounds[1] && z < bounds[3]
}

fn intersects(a: [i32; 4], b: [i32; 4]) -> bool {
    a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
}

fn validate_node(
    reader: &mut Reader<'_>,
    manifest: &LodManifest,
    reference: &NodeRef,
) -> Result<()> {
    let node = LodNode::decode(&reader.read(&reference.index, MAX_NODE_BYTES)?)?;
    ensure!(node.key == reference.key, "node key mismatch");
    let bounds = node.key.bounds()?;
    ensure!(
        intersects(bounds, manifest.bounds),
        "node outside dataset bounds"
    );
    let heights = HeightTile::decode(&decompress_lod(
        &reader.read(&node.height, MAX_TILE_BYTES)?,
    )?)?;
    ensure!(heights.key == node.key, "height key mismatch");
    let raw = decompress_lod(&reader.read(&node.data, MAX_TILE_BYTES)?)?;
    if node.key.level == 0 {
        let tile = DetailTile::decode(&raw)?;
        ensure!(tile.key == node.key, "detail key mismatch");
        for (i, c) in tile.columns.iter().enumerate() {
            ensure!(
                [2, 5, 8]
                    .into_iter()
                    .all(|j| (c[j] as usize) < manifest.material_count),
                "detail material outside catalog"
            );
            let x = bounds[0] + (i % TILE_SIDE) as i32;
            let z = bounds[1] + (i / TILE_SIDE) as i32;
            ensure!(
                (c[0] == 3) != inside(manifest.bounds, x, z),
                "detail outside coverage mismatch"
            );
        }
        ensure!(
            heights == HeightTile::from_detail(&tile)?,
            "detail/height mismatch"
        );
        for reference in &node.chunks {
            let chunk = reader.chunk(
                &reference.object,
                reference.cx,
                reference.cz,
                manifest.material_count,
            )?;
            for (i, column) in chunk.columns.iter().enumerate() {
                let x = chunk.cx * 16 + (i % 16) as i32;
                let z = chunk.cz * 16 + (i / 16) as i32;
                if inside(manifest.bounds, x, z) {
                    let j = (z - bounds[1]) as usize * TILE_SIDE + (x - bounds[0]) as usize;
                    ensure!(tile.columns[j] == *column, "chunk/detail mismatch");
                }
            }
        }
    } else {
        let tile = SummaryTile::decode(&raw)?;
        ensure!(tile.key == node.key, "summary key mismatch");
        ensure!(
            heights == HeightTile::from_summary(&tile)?,
            "summary/height mismatch"
        );
        if node.children.is_empty() {
            ensure!(
                tile.samples.iter().all(|s| s.flags & PRESENT == 0),
                "terminal summary contains present terrain"
            );
        } else {
            let expected: BTreeSet<_> = node
                .key
                .children()?
                .into_iter()
                .filter(|key| intersects(key.bounds().expect("validated child"), manifest.bounds))
                .collect();
            ensure!(
                node.children.iter().map(|r| r.key).collect::<BTreeSet<_>>() == expected,
                "missing intersecting child"
            );
        }
    }
    for (i, sample) in heights.samples.iter().enumerate() {
        if sample.flags & PRESENT != 0 {
            ensure!(
                sample.min_height >= manifest.height_range[0]
                    && sample.max_height <= manifest.height_range[1],
                "height outside declared range"
            );
        }
        let step = 1 << node.key.level;
        let x = bounds[0] + (i % TILE_SIDE) as i32 * step;
        let z = bounds[1] + (i / TILE_SIDE) as i32 * step;
        let sample_bounds = [x, z, x + step, z + step];
        let fully_inside =
            inside(manifest.bounds, x, z) && inside(manifest.bounds, x + step - 1, z + step - 1);
        ensure!(
            !fully_inside || sample.flags & OUTSIDE == 0,
            "outside flag inside dataset"
        );
        ensure!(
            intersects(sample_bounds, manifest.bounds) || sample.flags == OUTSIDE,
            "terrain outside dataset"
        );
    }
    // Drop decoded payloads before descending; only small node refs stay stacked.
    drop(raw);
    drop(heights);
    for child in &node.children {
        validate_node(reader, manifest, child)?;
    }
    Ok(())
}
