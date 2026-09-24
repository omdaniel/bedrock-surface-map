use super::*;
use crate::terrain::{EMPTY as EMPTY_COLUMN, UNKNOWN};

fn materials() -> Vec<Material> {
    [
        ("unknown", 0, [1., 0., 1., 1.]),
        ("grass", 1, [0.5, 0.5, 0.5, 1.]),
        ("stone", 0, [0.4, 0.5, 0.6, 1.]),
        ("sand", 0, [0.8, 0.7, 0.5, 1.]),
        ("water", 3, [0.1, 0.4, 0.7, 1.]),
        ("leaves", 2, [0.5, 0.5, 0.5, 0.5]),
        ("overlay", 0, [0.9, 0.1, 0.4, 0.6]),
    ]
    .into_iter()
    .map(|(name, tint, average)| Material {
        key: name.into(),
        name: name.into(),
        texture: name.into(),
        tint,
        approximate: false,
        uv: [0.; 4],
        average,
    })
    .collect()
}

fn detail() -> DetailTile {
    let mut tile = DetailTile::unknown(TileKey::new(0, -1, -2).unwrap()).unwrap();
    for (i, c) in tile.columns.iter_mut().enumerate() {
        *c = match i % 9 {
            0 => UNKNOWN,
            1 => EMPTY_COLUMN,
            2 => OUTSIDE_COLUMN,
            _ => [
                1,
                (i % 7000) as i32 - 2000,
                1 + (i % 6) as i32,
                (i * 997 % 0xffffff) as i32,
                if i % 2 == 0 { -1 } else { i as i32 },
                6,
                -200,
                (i % 385) as i32,
                3,
                -1024,
            ],
        };
    }
    tile.columns[3][4] = 0xdeadbeefu32 as i32;
    tile
}

#[test]
fn negative_keys_floor_parents_sign_roots_and_limits() {
    assert_eq!(
        TileKey::at(0, -1, -129).unwrap(),
        TileKey {
            level: 0,
            x: -1,
            z: -2
        }
    );
    assert_eq!(
        TileKey::new(0, -3, 3).unwrap().parent().unwrap(),
        TileKey {
            level: 1,
            x: -2,
            z: 1
        }
    );
    let roots = root_keys([-512, -512, 512, 512]).unwrap();
    assert_eq!(
        roots,
        vec![
            TileKey {
                level: 2,
                x: -1,
                z: -1
            },
            TileKey {
                level: 2,
                x: 0,
                z: -1
            },
            TileKey {
                level: 2,
                x: -1,
                z: 0
            },
            TileKey {
                level: 2,
                x: 0,
                z: 0
            }
        ]
    );
    assert_eq!(
        root_keys([0, 0, 1024, 1024]).unwrap(),
        vec![TileKey {
            level: 3,
            x: 0,
            z: 0
        }]
    );
    assert_eq!(
        root_keys([-1024, -1024, 0, 0]).unwrap(),
        vec![TileKey {
            level: 3,
            x: -1,
            z: -1
        }]
    );
    assert_eq!(
        root_keys([-WORLD_LIMIT, -WORLD_LIMIT, WORLD_LIMIT, WORLD_LIMIT])
            .unwrap()
            .len(),
        4
    );
    for key in roots {
        for child in key.children().unwrap() {
            assert_eq!(child.parent().unwrap(), key);
        }
    }
    assert!(TileKey::new(17, 0, 0).is_err());
    assert!(TileKey::new(16, 1, 0).is_err());
    assert!(TileKey::new(0, i32::MAX, 0).is_err());
    assert!(TileKey::new(16, -1, 0).unwrap().parent().is_err());
    assert!(root_keys([0, 0, 0, 1]).is_err());
    assert!(root_keys([-WORLD_LIMIT - 1, 0, 1, 1]).is_err());
}

#[test]
fn exact_all_fields_and_gpu_words_roundtrip() {
    let tile = detail();
    assert_eq!(DetailTile::decode(&tile.encode().unwrap()).unwrap(), tile);
    let gpu = tile.gpu_words();
    assert_eq!(gpu.len(), TILE_CELLS * 8);
    let c = tile.columns[3];
    assert_eq!(
        &gpu[24..32],
        &[c[1], c[2], c[3], c[5], c[7], c[8], c[6], c[0]].map(|v| v as u32)
    );
    assert_eq!(tile.columns[3][4] as u32, 0xdeadbeef);
    assert!(gpu[24] > i32::MAX as u32);
}

#[test]
fn constant_and_palette_channels_stay_lossless() {
    let constant = DetailTile::unknown(TileKey::new(0, 0, 0).unwrap()).unwrap();
    assert_eq!(constant.encode().unwrap().len(), 16 + 10 * 6);
    assert_eq!(
        DetailTile::decode(&constant.encode().unwrap()).unwrap(),
        constant
    );
    let mut palette = constant;
    for (i, c) in palette.columns.iter_mut().enumerate() {
        c[4] = [0, -1, i32::MAX][i % 3];
    }
    let raw = palette.encode().unwrap();
    assert!(raw.len() < 5000);
    assert_eq!(DetailTile::decode(&raw).unwrap(), palette);
}

#[test]
fn detail_region_crop_preserves_every_channel_and_negative_offset() {
    let mut r = SurfaceRegion::empty(-1, -1);
    let at = 255 * 256 + 255;
    r.coverage[at] = 1;
    r.heights[at] = -9;
    r.materials[at] = 2;
    r.tints[at] = 0x010203;
    r.biomes[at] = 0xdeadbeef;
    r.overlays[at] = 6;
    r.overlay_heights[at] = 7;
    r.water_depth[at] = 3;
    r.supports[at] = 3;
    r.support_heights[at] = -80;
    let tile = DetailTile::from_region(&r, TileKey::new(0, -1, -1).unwrap()).unwrap();
    assert_eq!(
        tile.columns[TILE_CELLS - 1],
        [1, -9, 2, 0x010203, 0xdeadbeefu32 as i32, 6, 7, 3, 3, -80]
    );
    assert!(DetailTile::from_region(&r, TileKey::new(0, 0, -1).unwrap()).is_err());
    r.coverage.pop();
    assert!(DetailTile::from_region(&r, TileKey::new(0, -1, -1).unwrap()).is_err());
}

#[test]
fn summary_and_height_exact_word_contract() {
    assert_eq!(std::mem::size_of::<SummarySample>(), 24);
    let s = SummarySample {
        original: [1, 2, 3],
        vivid: [4, 5, 6],
        mean_height: -3,
        min_height: -32,
        max_height: 50,
        present_fraction: 100,
        empty_fraction: 60,
        unknown_fraction: 50,
        water_fraction: 20,
        flags: ALL_FLAGS,
    };
    assert_eq!(
        s.gpu_words(),
        [
            0x00020001, 0x00040003, 0x00060005, 0xffe0fffd, 0x3c640032, 0x001f1432
        ]
    );
    let tile = SummaryTile {
        key: TileKey::new(1, -1, 0).unwrap(),
        samples: vec![s; TILE_CELLS],
    };
    let raw = tile.encode().unwrap();
    assert_eq!(raw.len(), 16 + 24 * TILE_CELLS);
    assert_eq!(SummaryTile::decode(&raw).unwrap(), tile);
    let height = HeightTile::from_summary(&tile).unwrap();
    assert_eq!(&height.gpu_words()[..2], &[0x001ffffd, 0x0032ffe0]);
    assert_eq!(
        HeightTile::decode(&height.encode().unwrap()).unwrap(),
        height
    );
    let detail = detail();
    let height = HeightTile::from_detail(&detail).unwrap();
    assert_eq!(height.gpu_words().len(), TILE_CELLS);
    assert_eq!(height.gpu_words()[0], 0x00048000);
    assert_eq!(height.gpu_words()[1], 0x00028000);
    assert_eq!(height.gpu_words()[2], 0x00088000);
    assert_eq!(
        HeightTile::decode(&height.encode().unwrap()).unwrap(),
        height
    );
}

#[test]
fn conservative_extrema_flags_survive_fraction_roundoff() {
    let absent = SummarySample::absent(UNKNOWN_FLAG);
    let mut peak = SummarySample {
        original: [100; 3],
        vivid: [200; 3],
        mean_height: -123,
        min_height: -1000,
        max_height: 5000,
        present_fraction: 255,
        empty_fraction: 0,
        unknown_fraction: 0,
        water_fraction: 255,
        flags: PRESENT | WATER,
    };
    for _ in 0..16 {
        peak = SummarySample::reduce([peak, absent, absent, absent]);
        peak.validate().unwrap();
        assert_eq!(
            (peak.min_height, peak.mean_height, peak.max_height),
            (-1000, -123, 5000)
        );
        assert_eq!(peak.flags, PRESENT | WATER | UNKNOWN_FLAG);
        assert_eq!(peak.original, [100; 3]);
    }
    assert_eq!(peak.present_fraction, 0);
    let empty = SummarySample::reduce([SummarySample::absent(EMPTY); 4]);
    assert_eq!(empty.flags, EMPTY);
    assert_eq!(empty.mean_height, MISSING_HEIGHT);
    assert_eq!(empty.empty_fraction, 255);
}

#[test]
fn parent_uses_correct_quadrants_and_only_present_extrema() {
    let key = TileKey::new(1, -1, -1).unwrap();
    let mats = materials();
    let children = key
        .children()
        .unwrap()
        .into_iter()
        .enumerate()
        .map(|(i, key)| {
            let mut tile = DetailTile::unknown(key).unwrap();
            tile.columns.fill([
                1,
                i as i32 * 100 - 100,
                2,
                0xffffff,
                -1,
                0,
                -32768,
                0,
                0,
                -32768,
            ]);
            SummaryTile::from_detail(&tile, &mats).unwrap()
        })
        .collect::<Vec<_>>();
    let parent = SummaryTile::from_children(
        key,
        [&children[0], &children[1], &children[2], &children[3]],
    )
    .unwrap();
    for (index, expected) in [(0, -100), (64, 0), (64 * 128, 100), (64 * 128 + 64, 200)] {
        assert_eq!(parent.samples[index].mean_height, expected);
        assert_eq!(parent.samples[index].min_height, expected);
        assert_eq!(parent.samples[index].max_height, expected);
    }
    assert!(
        SummaryTile::from_children(
            key,
            [&children[1], &children[0], &children[2], &children[3]]
        )
        .is_err()
    );
}

#[test]
fn absent_bounds_distinguish_unknown_outside_and_tiny_overlap() {
    let tile = SummaryTile::absent(TileKey::new(16, 0, 0).unwrap(), [0, 0, 1, 1]).unwrap();
    assert_eq!(tile.samples[0].flags, UNKNOWN_FLAG | OUTSIDE);
    assert_eq!(tile.samples[0].unknown_fraction, 0);
    assert_eq!(tile.samples[1].flags, OUTSIDE);
    tile.validate().unwrap();
}

fn near(a: [f32; 3], b: [f32; 3]) {
    for i in 0..3 {
        assert!((a[i] - b[i]).abs() < 2e-6, "{a:?} != {b:?}");
    }
}

#[test]
fn appearance_matches_unlit_shader_tint_water_overlay_and_grade() {
    let mats = materials();
    let mut c = [1, 200, 1, 0x80c040, -1, 0, -32768, 0, 3, 0];
    let [original, vivid] = appearance_colors(&c, &mats).unwrap();
    near(
        original,
        [0.5 * 128. / 255., 0.5 * 192. / 255., 0.5 * 64. / 255.],
    );
    let base = [0.93 * 128. / 255., 0.93 * 192. / 255., 0.93 * 64. / 255.];
    let grade = |v: [f32; 3]| {
        let l = v[0] * 0.2126 + v[1] * 0.7152 + v[2] * 0.0722;
        v.map(|x| ((l + (x - l) * 1.08) * 1.04).clamp(0., 1.))
    };
    near(vivid, grade(base));
    c[2] = 3;
    near(
        appearance_colors(&c, &mats).unwrap()[1],
        grade([0.8, 0.7, 0.5]).map(|x| x * 0.88),
    );
    c[2] = 5;
    let leafy = [0.64 * 128. / 255., 0.82 * 192. / 255., 0.56 * 64. / 255.].map(|v| v * 0.85);
    near(appearance_colors(&c, &mats).unwrap()[1], grade(leafy));
    c[2] = 4;
    c[7] = 7;
    c[5] = 6;
    for mode in 0..2 {
        let w = if mode == 0 {
            [0.08, 0.38, 0.64]
        } else {
            [0.055, 0.33, 0.72]
        };
        let opacity = 1. - (-7f32 * 0.16).exp();
        let mut expected = [0.; 3];
        for i in 0..3 {
            let water = (mats[3].average[i] * (1. - opacity) + w[i] * opacity)
                * (0.85 + 0.25 * mats[4].average[i]);
            expected[i] = water * (1. - 0.6 * 0.65) + mats[6].average[i] * (0.6 * 0.65);
        }
        near(
            appearance_colors(&c, &mats).unwrap()[mode],
            if mode == 0 { expected } else { grade(expected) },
        );
    }
    let mut bad = mats;
    bad[0].average[0] = f32::NAN;
    assert!(validate_materials(&bad).is_err());
}

#[test]
fn corruption_truncation_limits_and_zstd_checks() {
    let detail = detail();
    let raw = detail.encode().unwrap();
    for end in [0, 3, 15, 16, raw.len() - 1] {
        assert!(DetailTile::decode(&raw[..end]).is_err());
    }
    for (at, value) in [(3, b'2'), (4, 17), (5, 1), (16, 2), (17, 33)] {
        let mut bad = raw.clone();
        bad[at] = value;
        assert!(DetailTile::decode(&bad).is_err());
    }
    let mut bad = raw.clone();
    bad.push(0);
    assert!(DetailTile::decode(&bad).is_err());
    assert!(DetailTile::decode(&vec![0; MAX_TILE_BYTES + 1]).is_err());
    let mut bad = detail.clone();
    bad.columns[0][0] = 4;
    assert!(bad.encode().is_err());
    bad = detail.clone();
    bad.columns[3][1] = -32768;
    assert!(bad.encode().is_err());
    bad = detail.clone();
    bad.columns[3][2] = 65536;
    assert!(bad.encode().is_err());
    bad = detail;
    bad.columns.pop();
    assert!(bad.encode().is_err());
    let tile = SummaryTile::absent(TileKey::new(1, 0, 0).unwrap(), [0, 0, 256, 256]).unwrap();
    let raw = tile.encode().unwrap();
    assert!(SummaryTile::decode(&raw[..raw.len() - 1]).is_err());
    let mut bad = raw;
    bad[16 + 22] = 0x80;
    assert!(SummaryTile::decode(&bad).is_err());
    let mut encoder = zstd::stream::Encoder::new(Vec::new(), 3).unwrap();
    encoder.include_checksum(true).unwrap();
    std::io::Write::write_all(&mut encoder, &bad).unwrap();
    let packed = encoder.finish().unwrap();
    assert_eq!(crate::decompress(&packed, MAX_TILE_BYTES).unwrap(), bad);
    assert!(crate::decompress(&packed, 16).is_err());
    let mut corrupt = packed.clone();
    *corrupt.last_mut().unwrap() ^= 1;
    assert!(crate::decompress(&corrupt, MAX_TILE_BYTES).is_err());
    let mut trailing = packed.clone();
    trailing.extend(&packed);
    assert!(crate::decompress(&trailing, MAX_TILE_BYTES).is_err());
    assert!(crate::decompress(&packed[..packed.len() - 1], MAX_TILE_BYTES).is_err());
}

#[test]
fn node_validation_rejects_unrelated_children_bad_refs_and_oversize_json() {
    let reference = ObjectRef {
        url: format!("tiles/{}.zst", "0".repeat(64)),
        sha256: "0".repeat(64),
        bytes: 100,
    };
    let mut node = LodNode {
        key: TileKey::new(1, 0, 0).unwrap(),
        data: reference.clone(),
        height: reference.clone(),
        children: vec![],
        chunks: vec![],
    };
    assert_eq!(LodNode::decode(&node.encode().unwrap()).unwrap(), node);
    node.children.push(NodeRef {
        key: TileKey::new(0, 4, 0).unwrap(),
        index: reference.clone(),
    });
    assert!(node.encode().is_err());
    node.children.clear();
    node.data.url = "../secret".into();
    assert!(node.encode().is_err());
    node.data = reference;
    node.data.bytes = MAX_TILE_BYTES + 1;
    assert!(node.encode().is_err());
    assert!(LodNode::decode(&vec![b' '; MAX_NODE_BYTES + 1]).is_err());
}

#[test]
fn lod_decompression_preflights_small_content_with_large_window() {
    // Non-single segment, 256-byte content size, 16 MiB window. The body is
    // intentionally incomplete: rejection must happen at preflight, not allocation.
    let malicious = [0x28, 0xb5, 0x2f, 0xfd, 0x40, 0x70, 0, 0, 1, 0, 0];
    assert_eq!(
        decompress_lod(&malicious).unwrap_err().to_string(),
        "zstd window limit"
    );
    assert!(
        decompress_lod(&vec![0; MAX_TILE_BYTES + 1])
            .unwrap_err()
            .to_string()
            .contains("compressed")
    );
    let raw = DetailTile::unknown(TileKey::new(0, 0, 0).unwrap())
        .unwrap()
        .encode()
        .unwrap();
    let packed = zstd::encode_all(raw.as_slice(), 3).unwrap();
    assert_eq!(decompress_lod(&packed).unwrap(), raw);
}

#[test]
fn descriptor_contract_and_text_bounds_match_browser() {
    let reference = ObjectRef {
        url: format!("objects/{}.json", "0".repeat(64)),
        sha256: "0".repeat(64),
        bytes: 100,
    };
    let manifest = LodManifest {
        format_version: 1,
        kind: "surface-lod".into(),
        name: "Example".into(),
        bounds: [0, 0, 128, 128],
        spawn: [0, 64, 0],
        source_sha256: "1".repeat(64),
        generation: "example-1".into(),
        world_id: None,
        revision: 1,
        appearance_version: "1".into(),
        height_range: [1024, 1024],
        atlas: reference.clone(),
        material_count: 1,
        catalog: vec![CatalogPageRef {
            start: 0,
            count: 1,
            object: reference.clone(),
        }],
        roots: vec![NodeRef {
            key: TileKey::new(0, 0, 0).unwrap(),
            index: reference,
        }],
    };
    assert_eq!(
        LodManifest::decode(&manifest.encode().unwrap()).unwrap(),
        manifest
    );
    let value = serde_json::to_value(&manifest).unwrap();
    assert_eq!(value["catalog"][0]["start"], 0);
    assert!(value["catalog"][0].get("object").is_none());
    assert!(value["catalog"][0].get("url").is_some());
    assert!(value["roots"][0].get("index").is_some());
    assert!(value.get("world_id").is_none());
    let mut bad = manifest.clone();
    bad.source_sha256 = "legacy label".into();
    assert!(bad.encode().is_err());
    bad = manifest.clone();
    bad.atlas.bytes = MAX_ATLAS_BYTES + 1;
    assert!(bad.encode().is_err());
    bad = manifest.clone();
    bad.catalog[0].object.bytes = MAX_CATALOG_PAGE_BYTES + 1;
    assert!(bad.encode().is_err());
    bad = manifest.clone();
    bad.catalog[0].start = 1;
    assert!(bad.encode().is_err());
    bad = manifest.clone();
    bad.height_range = [i16::MIN; 2];
    assert!(bad.encode().is_err());
    bad = manifest.clone();
    bad.name = "\u{1f600}".repeat(129);
    assert!(bad.encode().is_err());
    bad = manifest;
    bad.world_id = Some("x".repeat(81));
    assert!(bad.encode().is_err());
    assert!(LodManifest::decode(&vec![b' '; MAX_DESCRIPTOR_BYTES + 1]).is_err());
    let mut mats = materials();
    mats[0].texture.clear();
    validate_materials(&mats).unwrap();
    mats[1].key = "x".repeat(4097);
    assert!(validate_materials(&mats).is_err());
}

#[test]
fn repeated_fraction_rounding_cannot_overflow_coverage_sum() {
    let sample = |p, e, u| SummarySample {
        original: [10; 3],
        vivid: [20; 3],
        mean_height: -12,
        min_height: -12,
        max_height: -12,
        present_fraction: p,
        empty_fraction: e,
        unknown_fraction: u,
        water_fraction: p,
        flags: PRESENT | EMPTY | UNKNOWN_FLAG | WATER,
    };
    let children = [
        sample(86, 86, 85),
        sample(86, 85, 86),
        sample(85, 86, 85),
        sample(85, 85, 86),
    ];
    for child in &children {
        child.validate().unwrap();
    }
    let mut parent = SummarySample::reduce(children);
    for _ in 0..16 {
        parent.validate().unwrap();
        assert!(
            u16::from(parent.present_fraction)
                + u16::from(parent.empty_fraction)
                + u16::from(parent.unknown_fraction)
                <= 255
        );
        assert_eq!(parent.flags, PRESENT | EMPTY | UNKNOWN_FLAG | WATER);
        assert_eq!(parent.min_height, -12);
        parent = SummarySample::reduce([parent, children[0], children[1], children[2]]);
    }
}

#[test]
fn exact_slab_snow_and_support_sixteenths_survive_all_page_codecs() {
    let mut mats = materials();
    mats[6].name = "snow_layer".into();
    mats[6].average = [0.94, 0.97, 1., 0.8];
    let mut tile = DetailTile::unknown(TileKey::new(0, -65536, 65535).unwrap()).unwrap();
    let columns = [
        [1, -8, 2, 0xffffff, -1, 0, -32768, 0, 2, -16],
        [1, 0, 2, 0xffffff, 0, 6, 2, 0, 2, -8],
        [1, 2, 6, 0xffffff, 1, 0, -32768, 0, 2, 0],
        [1, 16, 2, 0xffffff, i32::MIN, 6, 18, 0, 2, 8],
    ];
    for (index, c) in [0, 1, 128, 129].into_iter().zip(columns) {
        tile.columns[index] = c;
    }
    let exact = DetailTile::decode(&tile.encode().unwrap()).unwrap();
    assert_eq!(exact, tile);
    let heights = HeightTile::from_detail(&exact).unwrap();
    assert_eq!(
        HeightTile::decode(&heights.encode().unwrap()).unwrap(),
        heights
    );
    for (index, c) in [0, 1, 128, 129].into_iter().zip(columns) {
        let words = exact.gpu_words();
        assert_eq!(words[index * 8], c[1] as u32);
        assert_eq!(words[index * 8 + 6], c[6] as u32);
        assert_eq!(
            heights.gpu_words()[index],
            (c[1] as u16 as u32) | (u32::from(PRESENT) << 16)
        );
        assert_eq!(exact.columns[index][9], c[9]);
    }
    let key = tile.key.parent().unwrap();
    let children = key.children().unwrap().map(|child| {
        if child == tile.key {
            SummaryTile::from_detail(&exact, &mats).unwrap()
        } else {
            SummaryTile::absent(
                child,
                [-WORLD_LIMIT, -WORLD_LIMIT, WORLD_LIMIT, WORLD_LIMIT],
            )
            .unwrap()
        }
    });
    let summary = SummaryTile::from_children(
        key,
        [&children[0], &children[1], &children[2], &children[3]],
    )
    .unwrap();
    let summary = SummaryTile::decode(&summary.encode().unwrap()).unwrap();
    let sample = summary.samples[64 * 128];
    assert_eq!(
        (sample.min_height, sample.mean_height, sample.max_height),
        (-8, 3, 16)
    );
    assert_eq!(sample.flags, PRESENT);
    let height = HeightTile::from_summary(&summary).unwrap();
    assert_eq!(
        HeightTile::decode(&height.encode().unwrap()).unwrap(),
        height
    );
    assert_eq!(height.samples[64 * 128].min_height, -8);
    assert_eq!(height.samples[64 * 128].max_height, 16);
}

#[test]
fn world_edge_coordinates_remain_exact_at_every_level() {
    let points = [
        -WORLD_LIMIT,
        -WORLD_LIMIT + 1,
        -129,
        -128,
        -1,
        0,
        127,
        128,
        WORLD_LIMIT - 1,
    ];
    for level in 0..=MAX_LEVEL {
        let span = 128i64 << level;
        for x in points {
            for z in points {
                let key = TileKey::at(level, x, z).unwrap();
                assert_eq!(i64::from(key.x), i64::from(x).div_euclid(span));
                assert_eq!(i64::from(key.z), i64::from(z).div_euclid(span));
                let b = key.bounds().unwrap();
                assert!(b[0] <= x && x < b[2] && b[1] <= z && z < b[3]);
                assert!(b.iter().all(|v| (-WORLD_LIMIT..=WORLD_LIMIT).contains(v)));
                if level < MAX_LEVEL {
                    let parent = key.parent().unwrap();
                    assert_eq!(parent, TileKey::at(level + 1, x, z).unwrap());
                    assert!(parent.children().unwrap().contains(&key));
                }
            }
        }
        assert!(TileKey::at(level, WORLD_LIMIT, 0).is_err());
        assert!(TileKey::at(level, -WORLD_LIMIT - 1, 0).is_err());
    }
}
