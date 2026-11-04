use anyhow::{Result, bail};
use std::collections::BTreeMap;
use surface_core::{
    Material,
    lod::{
        ChunkRef, DetailTile, HeightTile, MAX_TILE_BYTES, NodeRef, OUTSIDE, OUTSIDE_COLUMN,
        ObjectRef, PRESENT, TileKey, UNKNOWN_FLAG, decompress_lod,
    },
    terrain::{EMPTY, SurfaceChunk, UNKNOWN},
};
use surface_sync::{
    lod_build::{BuiltNode, build_absent, build_leaf, build_parent},
    store::hash,
};

#[derive(Default)]
struct Objects(BTreeMap<String, Vec<u8>>);
impl Objects {
    fn read(&self, reference: &ObjectRef) -> Result<Vec<u8>> {
        self.0
            .get(&reference.url)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("missing object"))
    }
    fn install(&mut self, built: &BuiltNode) {
        for object in &built.objects {
            assert_eq!(hash(&object.bytes), object.reference.sha256);
            self.0
                .insert(object.reference.url.clone(), object.bytes.clone());
        }
    }
    fn chunk(&mut self, chunk: SurfaceChunk) -> ChunkRef {
        let bytes = zstd::encode_all(chunk.encode().unwrap().as_slice(), 3).unwrap();
        let sha256 = hash(&bytes);
        let object = ObjectRef {
            url: format!("objects/{sha256}.zst"),
            sha256,
            bytes: bytes.len(),
        };
        self.0.insert(object.url.clone(), bytes);
        ChunkRef {
            cx: chunk.cx,
            cz: chunk.cz,
            object,
        }
    }
}

fn materials() -> Vec<Material> {
    ["unknown", "stone", "water", "plant"]
        .into_iter()
        .map(|name| Material {
            key: format!("synthetic:{name}"),
            name: name.into(),
            texture: name.into(),
            tint: 0,
            approximate: false,
            uv: [0., 0., 1., 1.],
            average: [0.5, 0.6, 0.7, 1.],
        })
        .collect()
}
fn chunk(cx: i32, cz: i32, height: i32) -> SurfaceChunk {
    SurfaceChunk {
        cx,
        cz,
        columns: vec![[1, height, 1, 0x91bd59, 1, 0, -32768, 0, 1, height]; 256],
    }
}
fn detail(built: &BuiltNode) -> DetailTile {
    DetailTile::decode(&decompress_lod(&built.objects[0].bytes).unwrap()).unwrap()
}
fn empty_leaf(key: TileKey, bounds: [i32; 4], objects: &mut Objects) -> BuiltNode {
    let built = build_leaf(key, None, &[], bounds, &materials(), &mut |r| {
        objects.read(r)
    })
    .unwrap();
    objects.install(&built);
    built
}

#[test]
fn complete_negative_chunk_replaces_all_retained_fields_and_reuses_hashes() {
    let mut objects = Objects::default();
    let key = TileKey::new(0, -1, -1).unwrap();
    let bounds = key.bounds().unwrap();
    let mut source = chunk(-1, -1, 72);
    source.columns[0] = EMPTY;
    source.columns[1] = UNKNOWN;
    source.columns[2] = [1, 80, 2, 0x123456, 42, 3, 81, 3, 1, 32];
    let changed = objects.chunk(source.clone());
    let first = build_leaf(
        key,
        None,
        std::slice::from_ref(&changed),
        bounds,
        &materials(),
        &mut |r| objects.read(r),
    )
    .unwrap();
    let exact = detail(&first);
    for z in 0..16 {
        assert_eq!(
            &exact.columns[(112 + z) * 128 + 112..(112 + z) * 128 + 128],
            &source.columns[z * 16..z * 16 + 16]
        );
    }
    assert_eq!(exact.columns[0], UNKNOWN);
    objects.install(&first);
    let repeat = build_leaf(
        key,
        Some(&first.reference),
        &[changed],
        bounds,
        &materials(),
        &mut |r| objects.read(r),
    )
    .unwrap();
    assert_eq!(first.reference, repeat.reference);
    let replacement = objects.chunk(chunk(-1, -1, 16));
    let next = build_leaf(
        key,
        Some(&first.reference),
        &[replacement],
        bounds,
        &materials(),
        &mut |r| objects.read(r),
    )
    .unwrap();
    assert_ne!(first.reference, next.reference);
    assert_eq!(detail(&next).columns[112 * 128 + 114][1], 16);
    let heights = HeightTile::decode(&decompress_lod(&next.objects[1].bytes).unwrap()).unwrap();
    assert_eq!(heights.samples[112 * 128 + 114].mean_height, 16);
    assert_eq!(next.node.chunks.len(), 1);
}

#[test]
fn growing_bounds_restore_source_fields_instead_of_preserving_outside_mask() {
    let mut objects = Objects::default();
    let key = TileKey::new(0, -1, 0).unwrap();
    let source = objects.chunk(chunk(-1, 0, 48));
    let first = build_leaf(
        key,
        None,
        &[source],
        [-8, 0, 0, 8],
        &materials(),
        &mut |r| objects.read(r),
    )
    .unwrap();
    assert_eq!(detail(&first).columns[112], OUTSIDE_COLUMN);
    objects.install(&first);
    let expanded = build_leaf(
        key,
        Some(&first.reference),
        &[],
        [-128, 0, 0, 128],
        &materials(),
        &mut |r| objects.read(r),
    )
    .unwrap();
    assert_eq!(detail(&expanded).columns[112][1], 48);
    assert_eq!(detail(&expanded).columns[0], UNKNOWN);
}

#[test]
fn leaf_order_is_canonical_and_accepts_exactly_sixty_four_chunks() {
    let mut objects = Objects::default();
    let key = TileKey::new(0, -2, 1).unwrap();
    let mut refs = Vec::new();
    for z in 8..16 {
        for x in -16..-8 {
            refs.push(objects.chunk(chunk(x, z, (z + x) * 16)));
        }
    }
    let first = build_leaf(
        key,
        None,
        &refs,
        key.bounds().unwrap(),
        &materials(),
        &mut |r| objects.read(r),
    )
    .unwrap();
    refs.reverse();
    let second = build_leaf(
        key,
        None,
        &refs,
        key.bounds().unwrap(),
        &materials(),
        &mut |r| objects.read(r),
    )
    .unwrap();
    assert_eq!(first.reference, second.reference);
    assert_eq!(first.node.chunks.len(), 64);
    assert!(detail(&first).columns.iter().all(|c| c[0] == 1));
    refs.push(refs[0].clone());
    assert!(
        build_leaf(
            key,
            None,
            &refs,
            key.bounds().unwrap(),
            &materials(),
            &mut |r| objects.read(r)
        )
        .is_err()
    );
}

#[test]
fn parent_order_is_canonical_and_changed_child_updates_conservative_range() {
    let mut objects = Objects::default();
    let key = TileKey::new(1, -1, -1).unwrap();
    let bounds = key.bounds().unwrap();
    let keys = key.children().unwrap();
    let mut refs: Vec<_> = keys
        .into_iter()
        .map(|k| empty_leaf(k, bounds, &mut objects).reference)
        .collect();
    let first = build_parent(key, &refs, bounds, &materials(), &mut |r| objects.read(r)).unwrap();
    refs.reverse();
    let repeat = build_parent(key, &refs, bounds, &materials(), &mut |r| objects.read(r)).unwrap();
    assert_eq!(first.reference, repeat.reference);
    let source = objects.chunk(chunk(-1, -1, 160));
    let leaf = build_leaf(keys[3], None, &[source], bounds, &materials(), &mut |r| {
        objects.read(r)
    })
    .unwrap();
    objects.install(&leaf);
    refs[0] = leaf.reference;
    let next = build_parent(key, &refs, bounds, &materials(), &mut |r| objects.read(r)).unwrap();
    assert_ne!(first.reference, next.reference);
    assert!(
        next.summary
            .samples
            .iter()
            .any(|s| s.flags & PRESENT != 0 && s.max_height == 160)
    );
    assert!(next.summary.samples.iter().all(|s| s.flags & PRESENT == 0
        || s.min_height <= s.mean_height && s.mean_height <= s.max_height));
}

#[test]
fn missing_intersecting_children_are_errors_not_absence() {
    let mut objects = Objects::default();
    let key = TileKey::new(2, 0, 0).unwrap();
    let bounds = [1, 1, 257, 257];
    let mut refs = Vec::new();
    for child in key.children().unwrap() {
        let node = build_absent(child, bounds).unwrap();
        objects.install(&node);
        refs.push(node.reference);
    }
    assert!(
        build_parent(key, &refs[..3], bounds, &materials(), &mut |r| objects
            .read(r))
        .is_err()
    );
    let parent = build_parent(key, &refs, bounds, &materials(), &mut |r| objects.read(r)).unwrap();
    assert!(
        parent
            .summary
            .samples
            .iter()
            .any(|s| s.flags & UNKNOWN_FLAG != 0)
    );
    assert!(
        parent
            .summary
            .samples
            .iter()
            .any(|s| s.flags & OUTSIDE != 0)
    );
    assert!(
        parent
            .summary
            .samples
            .iter()
            .all(|s| s.flags & PRESENT == 0)
    );
    objects.0.remove(&refs[0].index.url);
    assert!(build_parent(key, &refs, bounds, &materials(), &mut |r| objects.read(r)).is_err());
    let single = [refs[1].clone()];
    let partial = build_parent(key, &single, [256, 0, 512, 256], &materials(), &mut |r| {
        objects.read(r)
    })
    .unwrap();
    assert_eq!(partial.node.children.len(), 1);
}

#[test]
fn changed_appearance_changes_summary_not_exact_retained_fields() {
    let mut objects = Objects::default();
    let key = TileKey::new(0, 0, 0).unwrap();
    let source = objects.chunk(chunk(0, 0, 48));
    let catalog = materials();
    let first = build_leaf(
        key,
        None,
        &[source],
        key.bounds().unwrap(),
        &catalog,
        &mut |r| objects.read(r),
    )
    .unwrap();
    objects.install(&first);
    let mut updated = catalog.clone();
    updated[1].average[0] = 0.1;
    let next = build_leaf(
        key,
        Some(&first.reference),
        &[],
        key.bounds().unwrap(),
        &updated,
        &mut |r| objects.read(r),
    )
    .unwrap();
    assert_eq!(first.reference, next.reference);
    assert_ne!(
        first.summary.samples[0].original,
        next.summary.samples[0].original
    );
}

#[test]
fn rejects_bad_references_keys_and_materials_without_silent_fallbacks() {
    let mut objects = Objects::default();
    let key = TileKey::new(0, 0, 0).unwrap();
    let source = objects.chunk(chunk(0, 0, 48));
    let mut bad = source.clone();
    bad.object.bytes = MAX_TILE_BYTES + 1;
    assert!(
        build_leaf(
            key,
            None,
            &[bad],
            key.bounds().unwrap(),
            &materials(),
            &mut |_| panic!("oversized reference was read")
        )
        .is_err()
    );
    let mut wrong_key = source.clone();
    wrong_key.cx = 1;
    assert!(
        build_leaf(
            key,
            None,
            &[wrong_key],
            key.bounds().unwrap(),
            &materials(),
            &mut |r| objects.read(r)
        )
        .is_err()
    );
    assert!(
        build_leaf(
            key,
            None,
            &[source.clone(), source.clone()],
            key.bounds().unwrap(),
            &materials(),
            &mut |_| panic!("duplicate was read")
        )
        .is_err()
    );
    assert!(
        build_leaf(
            key,
            None,
            std::slice::from_ref(&source),
            key.bounds().unwrap(),
            &materials()[..1],
            &mut |r| objects.read(r)
        )
        .is_err()
    );
    assert!(
        build_leaf(
            key,
            None,
            std::slice::from_ref(&source),
            key.bounds().unwrap(),
            &materials(),
            &mut |_| bail!("unavailable")
        )
        .is_err()
    );
    objects.0.get_mut(&source.object.url).unwrap()[0] ^= 1;
    assert!(
        build_leaf(
            key,
            None,
            &[source],
            key.bounds().unwrap(),
            &materials(),
            &mut |r| objects.read(r)
        )
        .is_err()
    );
}

#[test]
fn rejects_duplicate_unrelated_parent_and_mismatched_base() {
    let mut objects = Objects::default();
    let key = TileKey::new(1, 0, 0).unwrap();
    let bounds = key.bounds().unwrap();
    let leaf = empty_leaf(key.children().unwrap()[0], bounds, &mut objects);
    assert!(
        build_parent(
            key,
            &[leaf.reference.clone(), leaf.reference.clone()],
            bounds,
            &materials(),
            &mut |_| panic!("duplicate was read")
        )
        .is_err()
    );
    let wrong = NodeRef {
        key: TileKey::new(0, 3, 3).unwrap(),
        index: leaf.reference.index.clone(),
    };
    assert!(
        build_parent(key, &[wrong], bounds, &materials(), &mut |_| panic!(
            "unrelated was read"
        ))
        .is_err()
    );
    assert!(
        build_leaf(
            TileKey::new(0, 1, 0).unwrap(),
            Some(&leaf.reference),
            &[],
            bounds,
            &materials(),
            &mut |_| panic!("wrong base was read")
        )
        .is_err()
    );
}
