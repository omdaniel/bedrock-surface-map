use super::*;
use std::collections::BTreeSet;
use surface_core::terrain::Column;

fn node(root: &Path, reference: &NodeRef) -> LodNode {
    let bytes = read_object(root, &reference.index, MAX_NODE_BYTES).unwrap();
    let result = LodNode::decode(&bytes).unwrap();
    assert_eq!(result.key, reference.key);
    result
}

fn visit(
    root: &Path,
    reference: &NodeRef,
    counts: &mut [usize; 3],
    flags: &mut u16,
    range: &mut [i16; 2],
) {
    let n = node(root, reference);
    counts[n.key.level as usize] += 1;
    let data = decompress_lod(&read_object(root, &n.data, MAX_TILE_BYTES).unwrap()).unwrap();
    let height = HeightTile::decode(
        &decompress_lod(&read_object(root, &n.height, MAX_TILE_BYTES).unwrap()).unwrap(),
    )
    .unwrap();
    assert_eq!(height.key, n.key);
    if n.key.level == 0 {
        let detail = DetailTile::decode(&data).unwrap();
        assert_eq!(detail.key, n.key);
        assert_eq!(height, HeightTile::from_detail(&detail).unwrap());
        let r = fixture_region(n.key.x.div_euclid(2), n.key.z.div_euclid(2));
        assert_eq!(detail, DetailTile::from_region(&r, n.key).unwrap());
        for c in &detail.columns {
            *flags |= column_flags(c);
            if c[0] == 1 {
                range[0] = range[0].min(c[1] as i16);
                range[1] = range[1].max(c[1] as i16);
            }
        }
    } else {
        let summary = SummaryTile::decode(&data).unwrap();
        assert_eq!(summary.key, n.key);
        assert_eq!(height, HeightTile::from_summary(&summary).unwrap());
        assert_eq!(n.children.len(), 4);
    }
    for child in &n.children {
        visit(root, child, counts, flags, range);
    }
}

#[test]
fn lod_fixture_is_deterministic_complete_and_self_contained() {
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    let (manifest, diagnostics) = create_lod_fixture_with_diagnostics(a.path()).unwrap();
    assert_eq!(manifest, create_lod_fixture(b.path()).unwrap());
    assert_eq!(manifest.bounds, [-512, -512, 512, 512]);
    assert_eq!(manifest.roots.len(), 4);
    assert!(manifest.roots.iter().all(|r| r.key.level == 2));
    assert_eq!(manifest.material_count, 8);
    assert_eq!(manifest.catalog.len(), 1);
    assert!(a.path().join("source/manifest.json").is_file());
    let source_manifest: MapManifest =
        serde_json::from_slice(&fs::read(a.path().join("source/manifest.json")).unwrap()).unwrap();
    assert!(source_manifest.heights.is_empty() && source_manifest.heights_sha256.is_empty());
    let atlas = read_object(a.path(), &manifest.atlas, MAX_ATLAS_BYTES).unwrap();
    assert!(atlas.starts_with(b"\x89PNG\r\n\x1a\n"));
    let page = read_object(
        a.path(),
        &manifest.catalog[0].object,
        MAX_CATALOG_PAGE_BYTES,
    )
    .unwrap();
    let materials: Vec<Material> = serde_json::from_slice(&page).unwrap();
    assert_eq!(materials.len(), 8);
    assert_fixture_appearance(a.path(), &manifest, &materials);
    assert_eq!(diagnostics["node_count"], 84);
    assert_eq!(diagnostics["detail_tiles"], 64);
    assert_eq!(diagnostics["summary_tiles"], 20);
    assert_eq!(diagnostics["height_pages"], 84);
    assert_eq!(diagnostics["source_regions"], 16);
    assert_eq!(diagnostics["referenced_objects"], 254);
    assert_eq!(diagnostics["levels"][0]["nodes"], 64);
    assert_eq!(diagnostics["levels"][1]["nodes"], 16);
    assert_eq!(diagnostics["levels"][2]["nodes"], 4);
    let conversion_ms = diagnostics["conversion_elapsed_ms"].as_f64().unwrap();
    assert!(conversion_ms > 0. && diagnostics["elapsed_ms"].as_f64().unwrap() >= conversion_ms);
    let stored_bytes = fs::read_dir(a.path().join("objects"))
        .unwrap()
        .map(|entry| entry.unwrap().metadata().unwrap().len())
        .sum::<u64>()
        + fs::metadata(a.path().join("lod.json")).unwrap().len();
    assert_eq!(diagnostics["referenced_bytes"]["total"], stored_bytes);
    assert!(diagnostics["referenced_bytes"]["detail"].as_u64().unwrap() > 0);
    assert!(diagnostics["referenced_bytes"]["summary"].as_u64().unwrap() > 0);
    let mut counts = [0; 3];
    let mut flags = 0;
    let mut range = [i16::MAX, i16::MIN];
    for reference in &manifest.roots {
        visit(a.path(), reference, &mut counts, &mut flags, &mut range);
    }
    assert_eq!(counts, [64, 16, 4]);
    assert_eq!(flags, PRESENT | EMPTY | UNKNOWN_FLAG | WATER);
    assert_eq!(range, manifest.height_range);
    assert!(range[0] < 0 && range[1] >= 4800);
    assert_eq!(
        LodManifest::decode(&fs::read(a.path().join("lod.json")).unwrap()).unwrap(),
        manifest
    );
    let before = fs::read(a.path().join("source/manifest.json")).unwrap();
    assert_eq!(
        prepare_lod(&a.path().join("source/manifest.json"), a.path()).unwrap(),
        manifest
    );
    assert_eq!(
        fs::read(a.path().join("source/manifest.json")).unwrap(),
        before
    );
}

fn node_at(root: &Path, manifest: &LodManifest, x: i32, z: i32, level: u8) -> LodNode {
    let mut reference = manifest
        .roots
        .iter()
        .find(|r| r.key == TileKey::at(r.key.level, x, z).unwrap())
        .unwrap()
        .clone();
    loop {
        let n = node(root, &reference);
        if n.key.level == level {
            return n;
        }
        reference = n
            .children
            .iter()
            .find(|r| r.key == TileKey::at(r.key.level, x, z).unwrap())
            .unwrap()
            .clone();
    }
}

fn assert_fixture_appearance(root: &Path, manifest: &LodManifest, materials: &[Material]) {
    // Fixed unlit UNORM16 expectations use the fixture's atlas-quantized averages
    // and appearance-v1 grading. Two units allow f32 accumulation differences.
    type FixtureAppearance = (&'static str, i32, i32, Column, [[u16; 3]; 2]);
    let cases: [FixtureAppearance; 6] = [
        (
            "sand",
            -100,
            0,
            [1, 816, 3, 0x9aba62, 1, 0, -32768, 0, 3, 816],
            [[54998, 50886, 37779], [50641, 46576, 33621]],
        ),
        (
            "grass",
            0,
            200,
            [1, 608, 1, 0x70af50, 6, 0, -32768, 0, 1, 608],
            [[17835, 27867, 12739], [26990, 43903, 18399]],
        ),
        (
            "foliage",
            352,
            -352,
            [1, 704, 6, 0x70af50, 9, 0, -32768, 0, 1, 608],
            [[13140, 20531, 9385], [17271, 37052, 9868]],
        ),
        (
            "water/support",
            -256,
            0,
            [1, 384, 4, 0x70af50, 0, 0, -32768, 19, 3, 80],
            [[6816, 25352, 42971], [4375, 23364, 52324]],
        ),
        (
            "flower overlay",
            0,
            0,
            [1, 1664, 1, 0x70af50, 0, 7, 1666, 0, 1, 1664],
            [[31739, 22325, 18924], [39439, 32495, 23201]],
        ),
        (
            "snow overlay",
            200,
            -80,
            [1, 4112, 2, 0x4f995d, 11, 5, 4114, 0, 2, 4112],
            [[48224, 50280, 52582], [50004, 52313, 54899]],
        ),
    ];
    for (name, x, z, expected, palettes) in cases {
        let leaf = node_at(root, manifest, x, z, 0);
        let detail = DetailTile::decode(
            &decompress_lod(&read_object(root, &leaf.data, MAX_TILE_BYTES).unwrap()).unwrap(),
        )
        .unwrap();
        let i = z.rem_euclid(128) as usize * 128 + x.rem_euclid(128) as usize;
        assert_eq!(detail.columns[i], expected, "{name} at {x},{z}");
        let words = detail.gpu_words();
        assert_eq!(
            &words[i * 8..i * 8 + 8],
            &[
                expected[1],
                expected[2],
                expected[3],
                expected[5],
                expected[7],
                expected[8],
                expected[6],
                expected[0]
            ]
            .map(|v| v as u32)
        );
        let appearance = appearance_colors(&expected, materials).unwrap();
        for mode in 0..2 {
            for channel in 0..3 {
                assert!(
                    (appearance[mode][channel] * 65535. - f32::from(palettes[mode][channel])).abs()
                        <= 2.,
                    "{name} palette {mode} channel {channel}"
                );
            }
        }
        for level in 1..=2 {
            let n = node_at(root, manifest, x, z, level);
            let tile = SummaryTile::decode(
                &decompress_lod(&read_object(root, &n.data, MAX_TILE_BYTES).unwrap()).unwrap(),
            )
            .unwrap();
            let step = 1 << level;
            let origin = n.key.bounds().unwrap();
            let index = ((z - origin[1]) / step * 128 + (x - origin[0]) / step) as usize;
            let sample = tile.samples[index];
            let mut sums = [[0f64; 3]; 2];
            let mut heights = Vec::new();
            let mut flags = 0;
            // Direct area average of exact columns, independent of the native
            // hierarchical reducer. Shared production appearance is checked above.
            for dz in 0..step {
                for dx in 0..step {
                    let sx = (x.div_euclid(step) * step + dx).rem_euclid(128) as usize;
                    let sz = (z.div_euclid(step) * step + dz).rem_euclid(128) as usize;
                    let c = detail.columns[sz * 128 + sx];
                    assert_eq!(c[0], 1);
                    let colors = appearance_colors(&c, materials).unwrap();
                    for mode in 0..2 {
                        for channel in 0..3 {
                            sums[mode][channel] += f64::from(colors[mode][channel]) * 65535.;
                        }
                    }
                    heights.push(c[1]);
                    flags |= column_flags(&c);
                }
            }
            for mode in 0..2 {
                let actual = [sample.original, sample.vivid][mode];
                for channel in 0..3 {
                    let expected = sums[mode][channel] / f64::from(step * step);
                    assert!(
                        (f64::from(actual[channel]) - expected).abs() <= 2.,
                        "{name} L{level} palette {mode} channel {channel}"
                    );
                }
            }
            assert_eq!(sample.min_height as i32, *heights.iter().min().unwrap());
            assert_eq!(sample.max_height as i32, *heights.iter().max().unwrap());
            assert_eq!(sample.flags, flags);
            assert_eq!(sample.present_fraction, 255);
        }
    }
}

fn small_source(root: &Path, bounds: [i32; 4]) -> (PathBuf, Value) {
    let mut materials = fixture_materials();
    let atlas = crate::app::assets::synthetic(root, &mut materials).unwrap();
    let r = fixture_region(-1, -1);
    let raw = encode_live_region(&r).unwrap();
    let bytes = zstd::encode_all(raw.as_slice(), 3).unwrap();
    let surface = object(root, "zst", &bytes).unwrap();
    let v = json!({"format_version":1,"name":"Small source","bounds":bounds,"spawn":[-1,24,-1],
        "source_sha256":hash(b"small source"),"materials":materials,"atlas":atlas,
        "regions":[{"rx":-1,"rz":-1,"url":surface.url,"sha256":surface.sha256,"bytes":surface.bytes,"columns":65536}],
        "heights":"missing-world-height-file.zst"});
    let path = root.join("manifest.json");
    atomic_write(&path, &serde_json::to_vec(&v).unwrap()).unwrap();
    (path, v)
}

#[test]
fn lod_prepare_v1_preserves_source_and_masks_bounds_without_reading_heights() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let output = temp.path().join("output");
    let (path, _) = small_source(&source, [-4, -4, 4, 4]);
    let before = fs::read(&path).unwrap();
    let manifest = prepare_lod(&path, &output).unwrap();
    assert_eq!(fs::read(&path).unwrap(), before);
    assert_eq!(manifest.roots.len(), 4);
    let n = node(&output, &manifest.roots[0]);
    let detail = DetailTile::decode(
        &decompress_lod(&read_object(&output, &n.data, MAX_TILE_BYTES).unwrap()).unwrap(),
    )
    .unwrap();
    assert_eq!(detail.columns.iter().filter(|c| c[0] == 1).count(), 16);
    assert_eq!(
        detail.columns.iter().filter(|c| c[0] == 3).count(),
        TILE_CELLS - 16
    );
    let n = node(&output, &manifest.roots[3]);
    let detail = DetailTile::decode(
        &decompress_lod(&read_object(&output, &n.data, MAX_TILE_BYTES).unwrap()).unwrap(),
    )
    .unwrap();
    assert_eq!(detail.columns.iter().filter(|c| c[0] == 0).count(), 16);
    assert_eq!(
        detail.columns.iter().filter(|c| c[0] == 3).count(),
        TILE_CELLS - 16
    );
}

#[test]
fn lod_prepare_sparse_maximum_bounds_does_not_expand_unknown_world() {
    let temp = tempfile::tempdir().unwrap();
    let (path, mut value) = small_source(
        &temp.path().join("source"),
        [-WORLD_LIMIT, -WORLD_LIMIT, WORLD_LIMIT, WORLD_LIMIT],
    );
    value["regions"] = json!([]);
    atomic_write(&path, &serde_json::to_vec(&value).unwrap()).unwrap();
    let output = temp.path().join("output");
    let result = prepare_lod(&path, &output).unwrap();
    assert_eq!(result.roots.len(), 4);
    assert_eq!(result.height_range, [0, 0]);
    for r in &result.roots {
        assert_eq!(r.key.level, 16);
        let n = node(&output, r);
        assert!(n.children.is_empty());
        let tile = SummaryTile::decode(
            &decompress_lod(&read_object(&output, &n.data, MAX_TILE_BYTES).unwrap()).unwrap(),
        )
        .unwrap();
        assert!(
            tile.samples
                .iter()
                .all(|s| s.flags == UNKNOWN_FLAG && s.unknown_fraction == 255)
        );
    }
    assert_eq!(fs::read_dir(output.join("objects")).unwrap().count(), 14);
}

#[test]
fn lod_prepare_v2_copies_verified_chunk_references_and_identity() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let output = temp.path().join("output");
    let (path, mut v) = small_source(&source, [-128, -128, 0, 0]);
    let catalog = object(
        &source,
        "json",
        &serde_json::to_vec(&v["materials"]).unwrap(),
    )
    .unwrap();
    let atlas_bytes = fs::read(source.join(v["atlas"].as_str().unwrap())).unwrap();
    let atlas = object(&source, "png", &atlas_bytes).unwrap();
    let surface = ObjectRef {
        url: v["regions"][0]["url"].as_str().unwrap().into(),
        sha256: v["regions"][0]["sha256"].as_str().unwrap().into(),
        bytes: v["regions"][0]["bytes"].as_u64().unwrap() as usize,
    };
    let region = fixture_region(-1, -1);
    let mut chunks = serde_json::Map::new();
    for cz in -8..0 {
        for cx in -8..0 {
            let raw = SurfaceChunk::from_region(&region, cx, cz)
                .unwrap()
                .encode()
                .unwrap();
            let packed = zstd::encode_all(raw.as_slice(), 3).unwrap();
            chunks.insert(
                format!("{cx},{cz}"),
                serde_json::to_value(object(&source, "zst", &packed).unwrap()).unwrap(),
            );
        }
    }
    let index = object(
        &source,
        "json",
        &serde_json::to_vec(&json!({"rx":-1,"rz":-1,"surface":surface,"chunks":chunks})).unwrap(),
    )
    .unwrap();
    v["format_version"] = json!(2);
    v["catalog"] = json!(catalog);
    v["atlas"] = json!(atlas);
    v["regions"] = json!([{"rx":-1,"rz":-1,"surface":surface,"index":index}]);
    v["world_id"] = json!("synthetic-test");
    v["generation"] = json!("generation-2");
    v["revision"] = json!(17);
    atomic_write(&path, &serde_json::to_vec(&v).unwrap()).unwrap();
    let manifest = prepare_lod(&path, &output).unwrap();
    assert_eq!(manifest.world_id.as_deref(), Some("synthetic-test"));
    assert_eq!(manifest.generation, "generation-2");
    assert_eq!(manifest.revision, 17);
    let n = node(&output, &manifest.roots[0]);
    assert_eq!(n.chunks.len(), 64);
    let mut positions = BTreeSet::new();
    for c in n.chunks {
        let bytes = read_object(&output, &c.object, MAX_TILE_BYTES).unwrap();
        let chunk = SurfaceChunk::decode(&decompress(&bytes, 32 * 1024).unwrap()).unwrap();
        assert_eq!((chunk.cx, chunk.cz), (c.cx, c.cz));
        assert!(positions.insert((c.cx, c.cz)));
    }
}

#[test]
fn lod_catalog_pages_limit_encoded_size_and_entry_count() {
    let root = tempfile::tempdir().unwrap();
    let mut materials = vec![fixture_materials().remove(1); 600];
    for (i, m) in materials.iter_mut().enumerate() {
        m.key = format!("{i}-{}", "x".repeat(1000));
    }
    let pages = publish_catalog(root.path(), &materials).unwrap();
    assert!(pages.len() > 3);
    let mut next = 0;
    for p in pages {
        assert_eq!(p.start, next);
        assert!(p.count <= 256 && p.object.bytes <= MAX_CATALOG_PAGE_BYTES);
        let entries: Vec<Material> = serde_json::from_slice(
            &read_object(root.path(), &p.object, MAX_CATALOG_PAGE_BYTES).unwrap(),
        )
        .unwrap();
        assert_eq!(entries.len(), p.count);
        next += p.count;
    }
    assert_eq!(next, materials.len());
    materials[0].key = "x".repeat(MAX_CATALOG_PAGE_BYTES);
    assert!(publish_catalog(root.path(), &materials).is_err());
}

#[test]
fn lod_prepare_rejects_bad_hash_paths_catalog_and_region_identity() {
    let temp = tempfile::tempdir().unwrap();
    let (path, value) = small_source(&temp.path().join("source"), [-128, -128, 0, 0]);
    for (i, (field, replacement)) in [
        ("sha256", json!("0".repeat(64))),
        ("url", json!("../escape.zst")),
        ("rx", json!(1)),
    ]
    .into_iter()
    .enumerate()
    {
        let mut bad = value.clone();
        bad["regions"][0][field] = replacement;
        if field == "rx" {
            bad["bounds"] = json!([256, -128, 384, 0]);
        }
        atomic_write(&path, &serde_json::to_vec(&bad).unwrap()).unwrap();
        let output = temp.path().join(format!("bad-{i}"));
        assert!(prepare_lod(&path, &output).is_err());
        assert!(!output.join("lod.json").exists());
    }
    let mut bad = value;
    bad["materials"][1]["average"] = json!([4., 0., 0., 1.]);
    atomic_write(&path, &serde_json::to_vec(&bad).unwrap()).unwrap();
    assert!(prepare_lod(&path, &temp.path().join("bad-catalog")).is_err());
}

#[test]
fn lod_prepare_one_column_at_opposite_world_corners_clips_exactly() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let (path, mut value) = small_source(&source, [-128, -128, 0, 0]);
    for (i, (x, z)) in [
        (WORLD_LIMIT - 1, -WORLD_LIMIT),
        (-WORLD_LIMIT, WORLD_LIMIT - 1),
    ]
    .into_iter()
    .enumerate()
    {
        let mut region = fixture_region(-1, -1);
        region.rx = x.div_euclid(256);
        region.rz = z.div_euclid(256);
        let key = TileKey::at(0, x, z).unwrap();
        let sample = z.rem_euclid(128) as usize * 128 + x.rem_euclid(128) as usize;
        let expected = DetailTile::from_region(&region, key).unwrap().columns[sample];
        assert_eq!(expected[0], 1);
        let raw = encode_live_region(&region).unwrap();
        let reference = object(
            &source,
            "zst",
            &zstd::encode_all(raw.as_slice(), 3).unwrap(),
        )
        .unwrap();
        value["bounds"] = json!([x, z, x + 1, z + 1]);
        value["regions"] = json!([{"rx":region.rx,"rz":region.rz,"url":reference.url,
            "sha256":reference.sha256,"bytes":reference.bytes,"columns":65536}]);
        atomic_write(&path, &serde_json::to_vec(&value).unwrap()).unwrap();
        let output = temp.path().join(format!("corner-{i}"));
        let manifest = prepare_lod(&path, &output).unwrap();
        assert_eq!(manifest.roots.len(), 1);
        assert_eq!(manifest.roots[0].key, key);
        let n = node(&output, &manifest.roots[0]);
        let detail = DetailTile::decode(
            &decompress_lod(&read_object(&output, &n.data, MAX_TILE_BYTES).unwrap()).unwrap(),
        )
        .unwrap();
        assert_eq!(detail.columns[sample], expected);
        for (index, c) in detail.columns.iter().enumerate() {
            if index != sample {
                assert_eq!(*c, OUTSIDE_COLUMN);
            }
        }
        assert_eq!(manifest.height_range, [expected[1] as i16; 2]);
    }
}

#[test]
fn lod_fixture_legacy_reference_height_dimensions_and_manifest_match_native() {
    let temp = tempfile::tempdir().unwrap();
    let (lod, diagnostics) = create_lod_fixture_with_options(
        temp.path(),
        LodFixtureOptions {
            legacy_reference: true,
        },
    )
    .unwrap();
    let source = temp.path().join("source");
    let manifest: MapManifest =
        serde_json::from_slice(&fs::read(source.join("manifest.json")).unwrap()).unwrap();
    assert_eq!(manifest.format_version, 1);
    assert_eq!(manifest.bounds, [-512, -512, 512, 512]);
    assert_eq!(manifest.bounds, lod.bounds);
    assert_eq!(manifest.spawn, lod.spawn);
    assert_eq!(manifest.source_sha256, lod.source_sha256);
    assert_eq!(manifest.height_range, lod.height_range);
    assert_eq!(manifest.regions.len(), 16);
    assert_eq!(manifest.materials.len(), 8);
    assert_eq!(
        manifest.catalog_version,
        hash(&serde_json::to_vec(&manifest.materials).unwrap())
    );
    let materials: Vec<Material> = serde_json::from_slice(
        &read_object(temp.path(), &lod.catalog[0].object, MAX_CATALOG_PAGE_BYTES).unwrap(),
    )
    .unwrap();
    assert_eq!(
        serde_json::to_value(&manifest.materials).unwrap(),
        serde_json::to_value(&materials).unwrap()
    );
    let source_atlas = read_bounded(
        &source_path(&source, &manifest.atlas).unwrap(),
        MAX_ATLAS_BYTES,
    )
    .unwrap();
    assert_eq!(
        source_atlas,
        read_object(temp.path(), &lod.atlas, MAX_ATLAS_BYTES).unwrap()
    );
    let atlas = image::load_from_memory(&source_atlas).unwrap();
    assert!((4..=8192).contains(&atlas.width()) && (4..=8192).contains(&atlas.height()));
    assert!(atlas.width() * atlas.height() <= 8 * 1024 * 1024);

    let packed = read_bounded(
        &source_path(&source, &manifest.heights).unwrap(),
        MAX_DECOMPRESSED,
    )
    .unwrap();
    assert_eq!(hash(&packed), manifest.heights_sha256);
    let width = (manifest.bounds[2] - manifest.bounds[0]) as usize;
    let height = (manifest.bounds[3] - manifest.bounds[1]) as usize;
    assert_eq!((width, height), (1024, 1024));
    let raw = decompress(&packed, width * height * 2).unwrap();
    assert_eq!(raw.len(), 2 * 1024 * 1024);
    // This is the row-major i16 contract consumed by 57c66a::decode_heights.
    let height_at = |x: i32, z: i32| {
        let offset =
            ((z - manifest.bounds[1]) as usize * width + (x - manifest.bounds[0]) as usize) * 2;
        i16::from_le_bytes([raw[offset], raw[offset + 1]])
    };
    for (x, z, h) in [
        (0, 0, 1664),
        (-256, 0, 384),
        (200, -80, 4112),
        (127, -129, 4800),
        (32, 256, -192),
        (-448, 256, i16::MIN),
        (-320, 256, i16::MIN),
    ] {
        assert_eq!(height_at(x, z), h, "legacy sample {x},{z}");
    }
    let mut positions = BTreeSet::new();
    let mut missing = 0;
    for reference in &manifest.regions {
        assert!(positions.insert((reference.rx, reference.rz)));
        assert!(
            reference.rx * 256 >= manifest.bounds[0]
                && (reference.rx + 1) * 256 <= manifest.bounds[2]
        );
        assert!(
            reference.rz * 256 >= manifest.bounds[1]
                && (reference.rz + 1) * 256 <= manifest.bounds[3]
        );
        let reference_object = ObjectRef {
            url: reference.url.clone(),
            sha256: reference.sha256.clone(),
            bytes: reference.bytes,
        };
        let packed = read_object(&source, &reference_object, MAX_DECOMPRESSED).unwrap();
        let region = decode_region(&decompress(&packed, MAX_DECOMPRESSED).unwrap()).unwrap();
        assert_eq!(region, fixture_region(reference.rx, reference.rz));
        for (i, coverage) in region.coverage.iter().enumerate() {
            let expected = if *coverage == 1 {
                region.heights[i]
            } else {
                missing += 1;
                i16::MIN
            };
            let x = reference.rx * 256 + (i % 256) as i32;
            let z = reference.rz * 256 + (i / 256) as i32;
            assert_eq!(height_at(x, z), expected);
        }
    }
    assert_eq!(missing, 6144);
    assert_eq!(
        diagnostics["legacy_reference"]["manifest"],
        "source/manifest.json"
    );
    assert_eq!(diagnostics["legacy_reference"]["width"], 1024);
    assert_eq!(diagnostics["legacy_reference"]["height"], 1024);
    assert_eq!(diagnostics["legacy_reference"]["decoded_bytes"], raw.len());
    assert_eq!(
        diagnostics["legacy_reference"]["compressed_bytes"],
        packed.len()
    );
    assert_eq!(
        diagnostics["legacy_reference"]["height_sha256"],
        manifest.heights_sha256
    );
    assert_fixture_appearance(temp.path(), &lod, &manifest.materials);
}
