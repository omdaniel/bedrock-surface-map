use super::*;
use crate::state::State;
use serde_json::json;
use std::{collections::BTreeSet, io::Cursor, path::PathBuf};
use surface_core::{
    Material, SurfaceRegion, encode_live_region,
    lod::*,
    terrain::{SurfaceChunk, UNKNOWN},
};
use surface_sync::lod_build::{self, BuiltNode};

fn store(root: &Path, raw: &[u8], extension: &str) -> ObjectRef {
    let sha256 = digest(raw);
    let url = format!("objects/{sha256}.{extension}");
    fs::create_dir_all(root.join("objects")).unwrap();
    fs::write(root.join(&url), raw).unwrap();
    ObjectRef {
        url,
        sha256,
        bytes: raw.len(),
    }
}

// Uncompressed Zstd blocks let malformed codec fixtures be independently hashed
// without adding a compressor dependency to the native runtime crate.
fn packed(raw: &[u8]) -> Vec<u8> {
    let mut bytes = vec![0x28, 0xb5, 0x2f, 0xfd, 0xa0];
    bytes.extend_from_slice(&(raw.len() as u32).to_le_bytes());
    let blocks = raw.chunks(128 * 1024);
    let count = blocks.len();
    for (i, block) in blocks.enumerate() {
        let header = ((block.len() as u32) << 3) | u32::from(i + 1 == count);
        bytes.extend_from_slice(&header.to_le_bytes()[..3]);
        bytes.extend_from_slice(block);
    }
    assert_eq!(decompress_lod(&bytes).unwrap(), raw);
    bytes
}

fn appearance(root: &Path) -> (Vec<Material>, ObjectRef) {
    let materials = ["Unknown", "Stone"]
        .map(|name| Material {
            key: name.into(),
            name: name.into(),
            texture: name.into(),
            tint: 0,
            approximate: false,
            uv: [0., 0., 1., 1.],
            average: [0.5, 0.5, 0.5, 1.],
        })
        .to_vec();
    let mut png = Cursor::new(Vec::new());
    image::RgbaImage::from_pixel(1, 1, image::Rgba([128, 128, 128, 255]))
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
    (materials, store(root, &png.into_inner(), "png"))
}

fn save_node(root: &Path, node: BuiltNode) -> NodeRef {
    for object in node.objects {
        fs::write(root.join(object.reference.url), object.bytes).unwrap();
    }
    node.reference
}

fn descriptor(
    root: &Path,
    bounds: [i32; 4],
    roots: Vec<NodeRef>,
    materials: &[Material],
    atlas: ObjectRef,
) -> LodManifest {
    let catalog = store(root, &serde_json::to_vec(materials).unwrap(), "json");
    let manifest = LodManifest {
        format_version: 1,
        kind: "surface-lod".into(),
        name: "Validation fixture".into(),
        bounds,
        spawn: [bounds[0], 0, bounds[1]],
        source_sha256: "a".repeat(64),
        generation: "fixture".into(),
        world_id: None,
        revision: 1,
        appearance_version: APPEARANCE_VERSION.into(),
        height_range: [0, 32],
        atlas,
        catalog: vec![CatalogPageRef {
            start: 0,
            count: materials.len(),
            object: catalog,
        }],
        material_count: materials.len(),
        roots,
    };
    write_descriptor(root, &manifest);
    manifest
}

fn write_descriptor(root: &Path, manifest: &LodManifest) {
    fs::write(root.join("lod.json"), manifest.encode().unwrap()).unwrap();
}

fn leaf(root: &Path, key: TileKey, materials: &[Material], bounds: [i32; 4]) -> NodeRef {
    let mut chunk = SurfaceChunk {
        cx: key.x * 8,
        cz: key.z * 8,
        columns: vec![UNKNOWN; 256],
    };
    chunk.columns[0] = [1, 16, 1, 0xffffff, -1, 1, 32, 3, 1, 0];
    let reference = ChunkRef {
        cx: chunk.cx,
        cz: chunk.cz,
        object: store(root, &packed(&chunk.encode().unwrap()), "zst"),
    };
    let node = lod_build::build_leaf(key, None, &[reference], bounds, materials, &mut |r| {
        Ok(fs::read(root.join(&r.url))?)
    })
    .unwrap();
    save_node(root, node)
}

fn fine_fixture(root: &Path) -> LodManifest {
    let (materials, atlas) = appearance(root);
    let bounds = [-128, -128, 0, 0];
    let node = leaf(root, TileKey::new(0, -1, -1).unwrap(), &materials, bounds);
    descriptor(root, bounds, vec![node], &materials, atlas)
}

fn coarse_fixture(root: &Path) -> LodManifest {
    let (materials, atlas) = appearance(root);
    let bounds = [-256, -256, 0, 0];
    let key = TileKey::new(1, -1, -1).unwrap();
    let children: Vec<_> = key
        .children()
        .unwrap()
        .into_iter()
        .map(|k| leaf(root, k, &materials, bounds))
        .collect();
    let parent = lod_build::build_parent(key, &children, bounds, &materials, &mut |r| {
        Ok(fs::read(root.join(&r.url))?)
    })
    .unwrap();
    let node = save_node(root, parent);
    descriptor(root, bounds, vec![node], &materials, atlas)
}

fn node(root: &Path, reference: &NodeRef) -> LodNode {
    LodNode::decode(&fs::read(root.join(&reference.index.url)).unwrap()).unwrap()
}

fn replace_node(root: &Path, manifest: &mut LodManifest, node: &LodNode) {
    manifest.roots[0].index = store(root, &node.encode().unwrap(), "json");
    write_descriptor(root, manifest);
}

fn lod_error(root: &Path, message: &str) {
    let error = validate_lod(root).unwrap_err();
    assert!(format!("{error:#}").contains(message), "{error:#}");
}

#[test]
fn lod_closure_includes_exact_fine_coarse_height_catalog_and_chunk_objects() {
    let dir = tempfile::tempdir().unwrap();
    let manifest = coarse_fixture(dir.path());
    let verified = validate_lod(dir.path()).unwrap().unwrap();
    assert_eq!(verified.root, manifest);
    let mut expected: BTreeSet<_> = fs::read_dir(dir.path().join("objects"))
        .unwrap()
        .map(|e| PathBuf::from("objects").join(e.unwrap().file_name()))
        .collect();
    expected.insert(PathBuf::from("lod.json"));
    assert_eq!(verified.files, expected);
    fs::write(dir.path().join("objects/unlisted.json"), b"{}").unwrap();
    assert_eq!(validate_lod(dir.path()).unwrap().unwrap().files, expected);
}

#[test]
fn lod_objects_require_declared_lengths_hashes_and_presence() {
    let dir = tempfile::tempdir().unwrap();
    let mut manifest = fine_fixture(dir.path());
    let original = manifest.clone();
    let references = [
        manifest.atlas.clone(),
        manifest.catalog[0].object.clone(),
        manifest.roots[0].index.clone(),
    ];
    let root_node = node(dir.path(), &manifest.roots[0]);
    for reference in references.into_iter().chain([
        root_node.data,
        root_node.height,
        root_node.chunks[0].object.clone(),
    ]) {
        let path = dir.path().join(&reference.url);
        let bytes = fs::read(&path).unwrap();
        let mut corrupted = bytes.clone();
        corrupted[0] ^= 1;
        fs::write(&path, &corrupted).unwrap();
        lod_error(dir.path(), "length/hash mismatch");
        fs::remove_file(&path).unwrap();
        assert!(validate_lod(dir.path()).is_err());
        fs::write(&path, bytes).unwrap();
    }
    manifest.catalog[0].object.bytes += 1;
    write_descriptor(dir.path(), &manifest);
    lod_error(dir.path(), "length/hash mismatch");
    write_descriptor(dir.path(), &original);
    validate_lod(dir.path()).unwrap();
}

#[test]
fn lod_rejects_rehashed_key_material_height_and_chunk_disagreement() {
    let dir = tempfile::tempdir().unwrap();
    let original = fine_fixture(dir.path());
    let original_node = node(dir.path(), &original.roots[0]);
    for field in [2, 5, 8] {
        let mut manifest = original.clone();
        let mut node = original_node.clone();
        let mut tile = DetailTile::decode(
            &decompress_lod(&fs::read(dir.path().join(&node.data.url)).unwrap()).unwrap(),
        )
        .unwrap();
        tile.columns[0][field] = manifest.material_count as i32;
        node.data = store(dir.path(), &packed(&tile.encode().unwrap()), "zst");
        replace_node(dir.path(), &mut manifest, &node);
        lod_error(dir.path(), "material outside catalog");
    }
    let mut manifest = original.clone();
    let mut node = original_node.clone();
    let raw = decompress_lod(&fs::read(dir.path().join(&node.height.url)).unwrap()).unwrap();
    let mut heights = HeightTile::decode(&raw).unwrap();
    heights.samples[0].mean_height += 1;
    heights.samples[0].min_height += 1;
    heights.samples[0].max_height += 1;
    node.height = store(dir.path(), &packed(&heights.encode().unwrap()), "zst");
    replace_node(dir.path(), &mut manifest, &node);
    lod_error(dir.path(), "detail/height mismatch");

    node = original_node.clone();
    let mut tile = DetailTile::decode(
        &decompress_lod(&fs::read(dir.path().join(&node.data.url)).unwrap()).unwrap(),
    )
    .unwrap();
    tile.key.x = 0;
    node.data = store(dir.path(), &packed(&tile.encode().unwrap()), "zst");
    replace_node(dir.path(), &mut manifest, &node);
    lod_error(dir.path(), "detail key mismatch");

    node = original_node.clone();
    let mut chunk = SurfaceChunk::decode(
        &decompress_lod(&fs::read(dir.path().join(&node.chunks[0].object.url)).unwrap()).unwrap(),
    )
    .unwrap();
    chunk.columns[0][3] = 0;
    node.chunks[0].object = store(dir.path(), &packed(&chunk.encode().unwrap()), "zst");
    replace_node(dir.path(), &mut manifest, &node);
    lod_error(dir.path(), "chunk/detail mismatch");

    node = original_node;
    node.key.x = 0;
    node.chunks.clear();
    replace_node(dir.path(), &mut manifest, &node);
    lod_error(dir.path(), "node key mismatch");
}

#[test]
fn lod_rejects_missing_children_and_present_terminal_summaries() {
    let dir = tempfile::tempdir().unwrap();
    let mut manifest = coarse_fixture(dir.path());
    let mut root = node(dir.path(), &manifest.roots[0]);
    root.children.pop();
    replace_node(dir.path(), &mut manifest, &root);
    lod_error(dir.path(), "missing intersecting child");
    root.children.clear();
    replace_node(dir.path(), &mut manifest, &root);
    lod_error(dir.path(), "terminal summary contains present");
}

#[test]
fn lod_rejects_rehashed_catalogs_page_keys_and_decoder_windows() {
    let dir = tempfile::tempdir().unwrap();
    let original = fine_fixture(dir.path());
    let mut manifest = original.clone();
    let mut materials: Vec<Material> = serde_json::from_slice(
        &fs::read(dir.path().join(&manifest.catalog[0].object.url)).unwrap(),
    )
    .unwrap();
    materials[1].tint = 4;
    manifest.catalog[0].object =
        store(dir.path(), &serde_json::to_vec(&materials).unwrap(), "json");
    write_descriptor(dir.path(), &manifest);
    lod_error(dir.path(), "invalid material appearance");
    materials.pop();
    manifest.catalog[0].object =
        store(dir.path(), &serde_json::to_vec(&materials).unwrap(), "json");
    write_descriptor(dir.path(), &manifest);
    lod_error(dir.path(), "catalog page count mismatch");

    manifest = original.clone();
    let original_node = node(dir.path(), &manifest.roots[0]);
    let mut root = original_node.clone();
    let mut height = HeightTile::decode(
        &decompress_lod(&fs::read(dir.path().join(&root.height.url)).unwrap()).unwrap(),
    )
    .unwrap();
    height.key.x = 0;
    root.height = store(dir.path(), &packed(&height.encode().unwrap()), "zst");
    replace_node(dir.path(), &mut manifest, &root);
    lod_error(dir.path(), "height key mismatch");

    root = original_node.clone();
    let mut chunk = SurfaceChunk::decode(
        &decompress_lod(&fs::read(dir.path().join(&root.chunks[0].object.url)).unwrap()).unwrap(),
    )
    .unwrap();
    chunk.cx += 1;
    root.chunks[0].object = store(dir.path(), &packed(&chunk.encode().unwrap()), "zst");
    replace_node(dir.path(), &mut manifest, &root);
    lod_error(dir.path(), "chunk key mismatch");

    root = original_node;
    let malicious = [0x28, 0xb5, 0x2f, 0xfd, 0x40, 0x70, 0, 0, 1, 0, 0];
    root.data = store(dir.path(), &malicious, "zst");
    replace_node(dir.path(), &mut manifest, &root);
    lod_error(dir.path(), "zstd window limit");

    manifest = original;
    manifest.roots[0].index.bytes = MAX_NODE_BYTES + 1;
    fs::write(
        dir.path().join("lod.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    lod_error(dir.path(), "object byte limit");

    let coarse = tempfile::tempdir().unwrap();
    let mut manifest = coarse_fixture(coarse.path());
    let mut root = node(coarse.path(), &manifest.roots[0]);
    let mut summary = SummaryTile::decode(
        &decompress_lod(&fs::read(coarse.path().join(&root.data.url)).unwrap()).unwrap(),
    )
    .unwrap();
    summary.key.x = 0;
    root.data = store(coarse.path(), &packed(&summary.encode().unwrap()), "zst");
    replace_node(coarse.path(), &mut manifest, &root);
    lod_error(coarse.path(), "summary key mismatch");
}

#[test]
fn maximum_world_sparse_absence_needs_only_four_terminal_pages() {
    let dir = tempfile::tempdir().unwrap();
    let (materials, atlas) = appearance(dir.path());
    let bounds = [-WORLD_LIMIT, -WORLD_LIMIT, WORLD_LIMIT, WORLD_LIMIT];
    let roots = root_keys(bounds)
        .unwrap()
        .into_iter()
        .map(|key| {
            assert_eq!(key.level, 16);
            save_node(dir.path(), lod_build::build_absent(key, bounds).unwrap())
        })
        .collect();
    descriptor(dir.path(), bounds, roots, &materials, atlas);
    let validated = validate_lod(dir.path()).unwrap().unwrap();
    assert_eq!(validated.root.roots.len(), 4);
    assert_eq!(validated.files.len(), 15);
}

#[test]
fn legacy_optional_lod_and_state_inventory_keep_exact_allowlist() {
    let dir = tempfile::tempdir().unwrap();
    let state = State::new(dir.path().join("state")).unwrap();
    state.init().unwrap();
    let operation = state.operation("prepare-lod").unwrap();
    let public = operation.path().join("public");
    surface_cli::create_synthetic_fixture(&public).unwrap();
    assert!(validate_lod(&public).unwrap().is_none());
    let legacy = validate_inventory(&public).unwrap();
    let lod = surface_cli::lod::prepare_lod(&public.join("manifest.json"), &public).unwrap();
    assert_eq!(
        lod.source_sha256,
        digest(&fs::read(public.join("manifest.json")).unwrap())
    );
    validate(&public).unwrap();
    let closure = validate_inventory(&public).unwrap();
    assert!(legacy.is_subset(&closure));
    fs::write(public.join("objects/unlisted.json"), b"{}").unwrap();
    let error = state
        .register_staged_dataset(&public, "a".repeat(64), false)
        .unwrap_err();
    assert!(error.to_string().contains("unlisted public dataset file"));
    fs::remove_file(public.join("objects/unlisted.json")).unwrap();
    let selected = state
        .register_staged_dataset(&public, "a".repeat(64), false)
        .unwrap();
    let inventory = state
        .registered_inventory(&selected.dataset_id)
        .unwrap()
        .unwrap();
    assert_eq!(inventory.into_keys().collect::<BTreeSet<_>>(), closure);
    state.active_validated().unwrap();
}

fn stream_fixture(root: &Path, bounds: [i32; 4]) -> serde_json::Value {
    let (materials, atlas) = appearance(root);
    let catalog = store(root, &serde_json::to_vec(&materials).unwrap(), "json");
    let mut region = SurfaceRegion::empty(-1, -1);
    let mut chunk = SurfaceChunk {
        cx: -16,
        cz: -16,
        columns: vec![UNKNOWN; 256],
    };
    chunk.columns[0] = [
        1,
        16,
        1,
        0xffffff,
        -1,
        0,
        MISSING_HEIGHT as i32,
        0,
        0,
        MISSING_HEIGHT as i32,
    ];
    chunk.columns[1] = surface_core::terrain::EMPTY;
    chunk.apply(&mut region).unwrap();
    let chunk_ref = store(root, &packed(&chunk.encode().unwrap()), "zst");
    let surface = store(root, &packed(&encode_live_region(&region).unwrap()), "zst");
    let heights: Vec<_> = region
        .heights
        .iter()
        .flat_map(|h| h.to_le_bytes())
        .collect();
    let heights = store(root, &packed(&heights), "zst");
    let index = json!({"rx":-1,"rz":-1,"surface":surface,"heights":heights,"chunks":{"-16,-16":chunk_ref},"columns":2,"height_range":[16,16]});
    let index_ref = store(root, &serde_json::to_vec(&index).unwrap(), "json");
    let manifest = json!({"format_version":2,"rules_version":1,"name":"Stream fixture","world_id":"test","generation":"fixture","revision":7,"source_sha256":"a".repeat(64),
        "bounds":bounds,"spawn":[-128,0,-128],"height_range":[16,16],"atlas":atlas,"catalog":catalog,
        "regions":[{"rx":-1,"rz":-1,"index":index_ref,"surface":surface,"heights":heights,"columns":2,"height_range":[16,16]}]});
    fs::write(
        root.join("manifest.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    manifest
}

#[test]
fn v2_sparse_extreme_bounds_validate_one_region_without_global_height_allocation() {
    let dir = tempfile::tempdir().unwrap();
    stream_fixture(
        dir.path(),
        [-WORLD_LIMIT, -WORLD_LIMIT, WORLD_LIMIT, WORLD_LIMIT],
    );
    let files = validate_inventory(dir.path()).unwrap();
    assert_eq!(files.len(), 7);
}

#[test]
fn v2_and_lod_share_verified_chunks_and_catalog_with_independent_revisions() {
    let dir = tempfile::tempdir().unwrap();
    let source = stream_fixture(dir.path(), [-256, -256, 0, 0]);
    let before = validate_inventory(dir.path()).unwrap();
    let mut lod =
        surface_cli::lod::prepare_lod(&dir.path().join("manifest.json"), dir.path()).unwrap();
    lod.revision = 1;
    write_descriptor(dir.path(), &lod);
    let files = validate_inventory(dir.path()).unwrap();
    assert!(before.is_subset(&files));
    lod.generation = "different".into();
    write_descriptor(dir.path(), &lod);
    assert!(
        validate_inventory(dir.path())
            .unwrap_err()
            .to_string()
            .contains("identity mismatch")
    );
    fs::remove_file(dir.path().join("lod.json")).unwrap();
    let path = source["regions"][0]["index"]["url"].as_str().unwrap();
    let mut index: serde_json::Value =
        serde_json::from_slice(&fs::read(dir.path().join(path)).unwrap()).unwrap();
    index["rx"] = json!(0);
    let reference = store(dir.path(), &serde_json::to_vec(&index).unwrap(), "json");
    let mut source = source;
    source["regions"][0]["index"] = serde_json::to_value(reference).unwrap();
    fs::write(
        dir.path().join("manifest.json"),
        serde_json::to_vec(&source).unwrap(),
    )
    .unwrap();
    assert!(
        validate_inventory(dir.path())
            .unwrap_err()
            .to_string()
            .contains("index key mismatch")
    );
}

#[test]
fn v2_inventory_rejects_rehashed_regional_height_and_chunk_corruption() {
    for corrupt_height in [true, false] {
        let dir = tempfile::tempdir().unwrap();
        let mut manifest = stream_fixture(dir.path(), [-256, -256, 0, 0]);
        let path = manifest["regions"][0]["index"]["url"].as_str().unwrap();
        let mut index: serde_json::Value =
            serde_json::from_slice(&fs::read(dir.path().join(path)).unwrap()).unwrap();
        let error = if corrupt_height {
            let path = index["heights"]["url"].as_str().unwrap();
            let mut heights = decompress_lod(&fs::read(dir.path().join(path)).unwrap()).unwrap();
            heights[0] ^= 1;
            let reference = store(dir.path(), &packed(&heights), "zst");
            index["heights"] = serde_json::to_value(&reference).unwrap();
            manifest["regions"][0]["heights"] = serde_json::to_value(reference).unwrap();
            "stream surface/height mismatch"
        } else {
            let path = index["chunks"]["-16,-16"]["url"].as_str().unwrap();
            let mut chunk = SurfaceChunk::decode(
                &decompress_lod(&fs::read(dir.path().join(path)).unwrap()).unwrap(),
            )
            .unwrap();
            chunk.columns[0][3] = 0;
            index["chunks"]["-16,-16"] =
                serde_json::to_value(store(dir.path(), &packed(&chunk.encode().unwrap()), "zst"))
                    .unwrap();
            "stream chunk/surface mismatch"
        };
        manifest["regions"][0]["index"] = serde_json::to_value(store(
            dir.path(),
            &serde_json::to_vec(&index).unwrap(),
            "json",
        ))
        .unwrap();
        fs::write(
            dir.path().join("manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        assert!(
            validate_inventory(dir.path())
                .unwrap_err()
                .to_string()
                .contains(error)
        );
    }
}

#[cfg(unix)]
#[test]
fn lod_rejects_symlinks_traversal_and_dangling_descriptor() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let mut manifest = fine_fixture(dir.path());
    manifest.atlas.url = "../outside.png".into();
    fs::write(
        dir.path().join("lod.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    lod_error(dir.path(), "object URL");
    let manifest = fine_fixture(dir.path());
    let target = dir.path().join(&manifest.atlas.url);
    let saved = dir.path().join("saved.png");
    fs::rename(&target, &saved).unwrap();
    symlink(&saved, &target).unwrap();
    lod_error(dir.path(), "symlink");
    fs::remove_file(&target).unwrap();
    fs::rename(saved, target).unwrap();
    let objects = dir.path().join("objects");
    let renamed = dir.path().join("renamed");
    fs::rename(&objects, &renamed).unwrap();
    symlink(&renamed, &objects).unwrap();
    lod_error(dir.path(), "symlink");
    fs::remove_file(dir.path().join("lod.json")).unwrap();
    symlink(dir.path().join("absent"), dir.path().join("lod.json")).unwrap();
    assert!(validate_lod(dir.path()).is_err());
}
