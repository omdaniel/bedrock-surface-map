//! Shared validation/packing for the existing renderer's native LOD pages.
use anyhow::{Result, ensure};
use std::collections::BTreeMap;
use surface_core::lod::{DetailTile, HeightTile, SummarySample, SummaryTile, TILE_CELLS, TileKey};

pub const GPU_LIMIT: usize = 256 * 1024 * 1024;
pub const MISSING_HEIGHT: f32 = -1e6;
pub const SUMMARY_MARKER: u32 = 1 << 31;

pub fn decode_surface(bytes: &[u8], key: TileKey, material_count: u32) -> Result<Vec<u32>> {
    key.validate()?;
    ensure!(
        (1..=65536).contains(&material_count),
        "invalid material count"
    );
    let raw = surface_core::lod::decompress_lod(bytes)?;
    if key.level == 0 {
        let tile = DetailTile::decode(&raw)?;
        ensure!(tile.key == key, "LOD surface key mismatch");
        ensure!(
            tile.columns
                .iter()
                .all(|c| [2, 5, 8].into_iter().all(|i| c[i] < material_count as i32)),
            "LOD material ID outside catalog"
        );
        Ok(tile.gpu_words())
    } else {
        let tile = SummaryTile::decode(&raw)?;
        ensure!(tile.key == key, "LOD surface key mismatch");
        Ok(tile.gpu_words())
    }
}

pub fn decode_height(bytes: &[u8], key: TileKey) -> Result<Vec<f32>> {
    key.validate()?;
    let tile = HeightTile::decode(&surface_core::lod::decompress_lod(bytes)?)?;
    ensure!(tile.key == key, "LOD height key mismatch");
    Ok(tile
        .samples
        .iter()
        .map(|s| {
            if s.mean_height == surface_core::MISSING_HEIGHT {
                MISSING_HEIGHT
            } else {
                f32::from(s.mean_height) / 16.
            }
        })
        .collect())
}

/// Summary records retain all six transport words, followed by zero and a type
/// marker. Their first words are never material IDs. Both kinds occupy 32 GPU
/// bytes so the existing Cell storage binding and fine appearance stay shared.
pub fn pack_surface(key: TileKey, words: Vec<u32>, material_count: u32) -> Result<Vec<u32>> {
    key.validate()?;
    let record = if key.level == 0 { 8 } else { 6 };
    ensure!(
        words.len() == TILE_CELLS * record,
        "invalid LOD GPU data length"
    );
    if key.level == 0 {
        for c in words.chunks_exact(8) {
            ensure!(
                c[7] <= 3 && c[2] <= 0xffffff && c[4] <= 384,
                "invalid detail attributes"
            );
            ensure!(
                [1, 3, 5]
                    .into_iter()
                    .all(|i| c[i] < material_count && c[i] < 65536),
                "LOD material ID outside catalog"
            );
            ensure!(
                [0, 6]
                    .into_iter()
                    .all(|i| i16::try_from(c[i] as i32).is_ok()),
                "invalid detail height"
            );
            ensure!(
                c[7] != 1 || (c[0] as i32 != i32::from(surface_core::MISSING_HEIGHT) && c[1] != 0),
                "present detail missing surface"
            );
        }
        return Ok(words);
    }
    let mut packed = Vec::with_capacity(TILE_CELLS * 8);
    for w in words.chunks_exact(6) {
        SummarySample {
            original: [w[0] as u16, (w[0] >> 16) as u16, w[1] as u16],
            vivid: [(w[1] >> 16) as u16, w[2] as u16, (w[2] >> 16) as u16],
            mean_height: w[3] as i16,
            min_height: (w[3] >> 16) as i16,
            max_height: w[4] as i16,
            present_fraction: (w[4] >> 16) as u8,
            empty_fraction: (w[4] >> 24) as u8,
            unknown_fraction: w[5] as u8,
            water_fraction: (w[5] >> 8) as u8,
            flags: (w[5] >> 16) as u16,
        }
        .validate()?;
        packed.extend_from_slice(w);
        packed.extend_from_slice(&[0, SUMMARY_MARKER]);
    }
    Ok(packed)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DrawTile {
    pub key: TileKey,
    pub clip: [i32; 4],
}

pub fn draw_tiles(triples: &[i32]) -> Result<Vec<DrawTile>> {
    ensure!(
        triples.len().is_multiple_of(3),
        "LOD cut requires level,x,z triples"
    );
    let mut records = Vec::with_capacity(triples.len() / 3 * 7);
    for t in triples.chunks_exact(3) {
        let key = TileKey::new(u8::try_from(t[0])?, t[1], t[2])?;
        records.extend_from_slice(t);
        records.extend_from_slice(&key.bounds()?);
    }
    draw_cut(&records)
}

pub fn draw_cut(records: &[i32]) -> Result<Vec<DrawTile>> {
    ensure!(
        records.len().is_multiple_of(7),
        "LOD cut requires level,x,z,min_x,min_z,max_x,max_z records"
    );
    let mut cut = Vec::with_capacity(records.len() / 7);
    let mut edges = Vec::with_capacity(records.len() / 7 * 2);
    for (id, r) in records.chunks_exact(7).enumerate() {
        let key = TileKey::new(u8::try_from(r[0])?, r[1], r[2])?;
        let bounds = key.bounds()?;
        let clip = [r[3], r[4], r[5], r[6]];
        ensure!(
            clip[0] < clip[2]
                && clip[1] < clip[3]
                && clip[0] >= bounds[0]
                && clip[1] >= bounds[1]
                && clip[2] <= bounds[2]
                && clip[3] <= bounds[3],
            "LOD clip must be nonempty and inside its tile"
        );
        cut.push(DrawTile { key, clip });
        // Remove ending intervals before adding starts at the same X.
        edges.push((clip[0], 1, id));
        edges.push((clip[2], 0, id));
    }
    edges.sort_unstable();
    let mut active: BTreeMap<(i32, usize), i32> = BTreeMap::new();
    for (_, kind, id) in edges {
        let [_, lo, _, hi] = cut[id].clip;
        if kind == 0 {
            active.remove(&(lo, id));
        } else {
            ensure!(
                active
                    .range(..=(lo, usize::MAX))
                    .next_back()
                    .is_none_or(|(_, end)| *end <= lo)
                    && active
                        .range((lo, 0)..)
                        .next()
                        .is_none_or(|((start, _), _)| *start >= hi),
                "overlapping LOD draw clips"
            );
            active.insert((lo, id), hi);
        }
    }
    Ok(cut)
}

/// Half-open world clips partition pixel centers, including fractional zoom.
/// Shared edges round identically, so adjacent clips neither overlap nor crack.
pub fn scissor(
    clip: [i32; 4],
    cx: f32,
    cz: f32,
    scale: f32,
    width: u32,
    height: u32,
) -> Option<[u32; 4]> {
    if !cx.is_finite()
        || !cz.is_finite()
        || !scale.is_finite()
        || scale <= 0.
        || clip[0] >= clip[2]
        || clip[1] >= clip[3]
    {
        return None;
    }
    let pixel = |v: i32, center: f32, side: u32| {
        (((f64::from(v) - f64::from(center)) * f64::from(scale) + f64::from(side) / 2. - 0.5)
            .ceil())
        .clamp(0., f64::from(side)) as u32
    };
    let (x0, z0) = (pixel(clip[0], cx, width), pixel(clip[1], cz, height));
    let (x1, z1) = (pixel(clip[2], cx, width), pixel(clip[3], cz, height));
    (x0 < x1 && z0 < z1).then_some([x0, z0, x1 - x0, z1 - z0])
}

pub fn height_dimensions(bounds: &[i32], stride: usize, samples: usize) -> Result<(usize, usize)> {
    ensure!(
        bounds.len() == 4 && stride.is_power_of_two() && stride <= 65536,
        "height window bounds or stride"
    );
    let width = i64::from(bounds[2]) - i64::from(bounds[0]);
    let height = i64::from(bounds[3]) - i64::from(bounds[1]);
    ensure!(
        width > 0 && height > 0 && width % stride as i64 == 0 && height % stride as i64 == 0,
        "height window dimensions must align to stride"
    );
    let (w, h) = (width as u64 / stride as u64, height as u64 / stride as u64);
    ensure!(
        w * h == samples as u64 && samples <= 16 * 1024 * 1024,
        "height field exceeds 16M samples or has wrong length"
    );
    Ok((w as usize, h as usize))
}

pub fn fine_height_coverage(key: TileKey, bounds: [f32; 4], stride: f32) -> bool {
    if key.level != 0 {
        return true;
    }
    let Ok([x, z, end_x, end_z]) = key.bounds() else {
        return false;
    };
    stride == 1.
        && x as f32 >= bounds[0]
        && z as f32 >= bounds[1]
        && end_x as f32 <= bounds[0] + bounds[2]
        && end_z as f32 <= bounds[1] + bounds[3]
}

/// Validate a whole decoded height page, then map its world origin to an active
/// window's sample grid. Nonmatching strides, partial/outside pages and shifted
/// sample grids are not patchable. Validate before returning None as well.
pub fn height_patch_origin(
    key: TileKey,
    window: [i32; 4],
    window_stride: usize,
    values: &[f32],
) -> Result<Option<[usize; 2]>> {
    let bounds = key.bounds()?;
    ensure!(
        values.len() == TILE_CELLS,
        "LOD height patch must contain 128x128 samples"
    );
    ensure!(
        values.iter().all(|v| v.is_finite()),
        "LOD height patch samples must be finite"
    );
    let stride = 1usize << key.level;
    if stride != window_stride
        || bounds[0] < window[0]
        || bounds[1] < window[1]
        || bounds[2] > window[2]
        || bounds[3] > window[3]
    {
        return Ok(None);
    }
    let x = i64::from(bounds[0]) - i64::from(window[0]);
    let z = i64::from(bounds[1]) - i64::from(window[1]);
    if x % stride as i64 != 0 || z % stride as i64 != 0 {
        return Ok(None);
    }
    Ok(Some([
        (x / stride as i64) as usize,
        (z / stride as i64) as usize,
    ]))
}

pub fn mip_bytes(width: u32, height: u32, levels: u32) -> usize {
    (0..levels)
        .map(|level| (width >> level).max(1) as usize * (height >> level).max(1) as usize * 4)
        .sum()
}

pub fn tile_bytes(words: usize, side: u32) -> usize {
    words * 4 + 16 + mip_bytes(side, side, side.ilog2() + 1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use surface_core::lod::{EMPTY, PRESENT, UNKNOWN_FLAG};

    #[test]
    fn height_page_patch_mapping_is_exact_bounded_and_validates_before_skipping() {
        let values = vec![MISSING_HEIGHT; TILE_CELLS];
        for level in 0..=16 {
            let key = TileKey::new(level, -1, 0).unwrap();
            let span = 128 << level;
            let stride = 1usize << level;
            assert_eq!(
                height_patch_origin(key, [-2 * span, -span, span, 2 * span], stride, &values)
                    .unwrap(),
                Some([128, 128])
            );
            assert_eq!(
                height_patch_origin(key, [-span, 0, 0, span], stride, &values).unwrap(),
                Some([0, 0])
            );
            for window in [
                [-span + 1, 0, 0, span],
                [-span, 1, 0, span],
                [-span, 0, -1, span],
                [-span, 0, 0, span - 1],
                [0, 0, span, span],
            ] {
                assert_eq!(
                    height_patch_origin(key, window, stride, &values).unwrap(),
                    None
                );
            }
            assert_eq!(
                height_patch_origin(key, [-span, 0, 0, span], stride * 2, &values).unwrap(),
                None
            );
            if level > 0 {
                assert_eq!(
                    height_patch_origin(key, [-span - 1, 0, span - 1, span], stride, &values)
                        .unwrap(),
                    None
                );
            }
        }
        let key = TileKey::new(0, 0, 0).unwrap();
        let outside = [128, 128, 256, 256];
        assert!(height_patch_origin(key, outside, 2, &values[..TILE_CELLS - 1]).is_err());
        assert!(height_patch_origin(key, outside, 2, &vec![0.; TILE_CELLS + 1]).is_err());
        for invalid in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            let mut values = values.clone();
            values[TILE_CELLS - 1] = invalid;
            assert!(height_patch_origin(key, outside, 2, &values).is_err());
        }
        assert!(
            height_patch_origin(
                TileKey {
                    level: 17,
                    x: 0,
                    z: 0
                },
                outside,
                1,
                &values
            )
            .is_err()
        );
        assert!(
            height_patch_origin(
                TileKey {
                    level: 0,
                    x: i32::MAX,
                    z: 0
                },
                outside,
                1,
                &values
            )
            .is_err()
        );
    }

    // A single-segment Zstd frame containing raw blocks; no test-only compressor
    // dependency or lockfile mutation is needed for transport validation.
    fn frame(raw: &[u8]) -> Vec<u8> {
        let mut out = vec![0x28, 0xb5, 0x2f, 0xfd, 0xa0];
        out.extend_from_slice(&(raw.len() as u32).to_le_bytes());
        let count = raw.len().div_ceil(128 * 1024);
        for (i, chunk) in raw.chunks(128 * 1024).enumerate() {
            let header = ((chunk.len() as u32) << 3) | u32::from(i + 1 == count);
            out.extend_from_slice(&header.to_le_bytes()[..3]);
            out.extend_from_slice(chunk);
        }
        out
    }

    #[test]
    fn transport_and_gpu_packing_validate_keys_materials_and_shape() {
        let key = TileKey::new(0, -1, 0).unwrap();
        let mut tile = DetailTile::unknown(key).unwrap();
        tile.columns[0] = [1, -17, 2, 0xabcdef, -1, 1, -16, 0, 2, -32];
        let raw = tile.encode().unwrap();
        let bytes = frame(&raw);
        let words = decode_surface(&bytes, key, 3).unwrap();
        assert_eq!(words, tile.gpu_words());
        assert_eq!(pack_surface(key, words.clone(), 3).unwrap(), words);
        assert!(decode_surface(&bytes, key, 2).is_err());
        assert!(decode_surface(&bytes, TileKey::new(0, 0, 0).unwrap(), 3).is_err());
        assert!(decode_surface(&bytes, TileKey::new(1, -1, 0).unwrap(), 3).is_err());
        assert!(decode_surface(&bytes[..bytes.len() - 1], key, 3).is_err());
        assert!(decode_surface(&vec![0; surface_core::lod::MAX_TILE_BYTES + 1], key, 3).is_err());
        assert!(pack_surface(key, vec![0; TILE_CELLS * 8 - 1], 3).is_err());
        let mut corrupt = words;
        corrupt[7] = SUMMARY_MARKER;
        assert!(pack_surface(key, corrupt, 3).is_err());

        let key = TileKey::new(4, -2, 3).unwrap();
        let mut s = SummarySample::absent(PRESENT | UNKNOWN_FLAG);
        s.original = [100, 200, 300];
        s.vivid = [400, 500, 600];
        s.mean_height = -17;
        s.min_height = -32;
        s.max_height = 16;
        s.present_fraction = 128;
        s.unknown_fraction = 127;
        let tile = SummaryTile {
            key,
            samples: vec![s; TILE_CELLS],
        };
        let words = decode_surface(&frame(&tile.encode().unwrap()), key, 1).unwrap();
        assert_eq!(words.len(), TILE_CELLS * 6);
        let packed = pack_surface(key, words.clone(), 1).unwrap();
        assert_eq!(packed.len(), TILE_CELLS * 8);
        assert_eq!(&packed[..6], &words[..6]);
        assert_eq!(&packed[6..8], &[0, SUMMARY_MARKER]);
        let heights = HeightTile::from_summary(&tile).unwrap();
        assert_eq!(
            decode_height(&frame(&heights.encode().unwrap()), key).unwrap()[0],
            -17. / 16.
        );
        let mut absent = tile;
        absent.samples.fill(SummarySample::absent(EMPTY));
        let heights = HeightTile::from_summary(&absent).unwrap();
        let bytes = frame(&heights.encode().unwrap());
        assert!(decode_height(&bytes, TileKey::new(4, -1, 3).unwrap()).is_err());
        assert!(
            decode_height(&bytes, key)
                .unwrap()
                .iter()
                .all(|h| *h == MISSING_HEIGHT)
        );
    }

    #[test]
    fn cuts_dimensions_and_exact_accounting() {
        assert!(draw_tiles(&[1, -1, 0, 0, -1, 0]).is_err());
        assert!(draw_tiles(&[0, -1, 0, 0, -1, 0]).is_err());
        assert!(draw_tiles(&[256, 0, 0]).is_err());
        assert!(draw_tiles(&[0, 0]).is_err());
        assert_eq!(draw_tiles(&[1, -1, 0, 0, 0, 0]).unwrap().len(), 2);
        for shift in 0..=16 {
            let stride = 1 << shift;
            assert_eq!(
                height_dimensions(
                    &[-8388608, 0, 0, 128 * stride as i32],
                    stride,
                    (8388608 / stride) * 128
                )
                .is_ok(),
                shift >= 6
            );
            assert_eq!(
                height_dimensions(
                    &[0, 0, 128 * stride as i32, 128 * stride as i32],
                    stride,
                    TILE_CELLS
                )
                .unwrap(),
                (128, 128)
            );
        }
        for stride in [0, 3, 131072] {
            assert!(height_dimensions(&[0, 0, 256, 256], stride, 1).is_err());
        }
        assert!(height_dimensions(&[0, 0, 127, 128], 2, 63 * 64).is_err());
        assert!(height_dimensions(&[i32::MAX, 0, i32::MIN, 128], 1, 1).is_err());
        assert_eq!(mip_bytes(128, 128, 8), 87380);
        assert_eq!(tile_bytes(TILE_CELLS * 8, 128), 611684);
        assert_eq!(mip_bytes(5, 7, 3), (35 + 6 + 1) * 4);
        let key = TileKey::new(0, -1, 0).unwrap();
        assert!(fine_height_coverage(key, [-128., 0., 128., 128.], 1.));
        assert!(!fine_height_coverage(key, [-128., 0., 128., 128.], 2.));
        assert!(!fine_height_coverage(key, [-127., 0., 128., 128.], 1.));
    }

    #[test]
    fn clipped_parent_fallback_partitions_negative_world_and_pixel_centers() {
        let cut = [
            1, -1, 0, -256, 0, -128, 128, 0, -1, 0, -128, 0, 0, 128, 1, -1, 0, -256, 128, 0, 256,
        ];
        let tiles = draw_cut(&cut).unwrap();
        assert_eq!(tiles.len(), 3);
        assert!(draw_cut(&[1, -1, 0, -257, 0, -128, 128]).is_err());
        assert!(draw_cut(&[1, -1, 0, -128, 0, -128, 128]).is_err());
        let mut overlapping = cut;
        overlapping[5] = -127;
        assert!(draw_cut(&overlapping).is_err());
        for scale in [0.01, 0.7, 1., 2.75, 16.] {
            for center in [-128., -127.5, -100.13] {
                let parent = scissor([-256, 0, 0, 256], center, 128., scale, 301, 201);
                let clips: Vec<_> = tiles
                    .iter()
                    .filter_map(|t| scissor(t.clip, center, 128., scale, 301, 201))
                    .collect();
                let mut area = 0;
                for z in 0..201 {
                    for x in 0..301 {
                        let covered = |s: [u32; 4]| {
                            x >= s[0] && x < s[0] + s[2] && z >= s[1] && z < s[1] + s[3]
                        };
                        let count = clips.iter().filter(|s| covered(**s)).count();
                        assert_eq!(count, usize::from(parent.is_some_and(covered)));
                        area += count;
                    }
                }
                assert!(area > 0);
            }
        }
        assert_eq!(
            scissor([0, 0, 128, 128], -1000., -1000., 1., 100, 100),
            None
        );
    }
}
