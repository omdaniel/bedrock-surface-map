use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::Read;

pub const SIDE: usize = 256;
pub const CELLS: usize = SIDE * SIDE;
pub const VERSION: u32 = 1;
pub const MISSING_HEIGHT: i16 = i16::MIN;
pub const MAX_DECOMPRESSED: usize = 8 * 1024 * 1024;
pub const SUN_STEP: f32 = 2.449_489_8; // tan(60 degrees) * sqrt(2), NW diagonal.

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SurfaceRegion {
    pub rx: i32,
    pub rz: i32,
    pub coverage: Vec<u32>,
    pub heights: Vec<i16>, // sixteenths of a block, top face
    pub materials: Vec<u32>,
    pub tints: Vec<u32>, // packed RGB; source biome IDs retained separately
    pub biomes: Vec<u32>,
    pub overlays: Vec<u32>,
    pub overlay_heights: Vec<i16>,
    pub water_depth: Vec<u32>,
    pub supports: Vec<u32>,
    pub support_heights: Vec<i16>,
}

impl SurfaceRegion {
    pub fn empty(rx: i32, rz: i32) -> Self {
        Self {
            rx,
            rz,
            coverage: vec![0; CELLS],
            heights: vec![MISSING_HEIGHT; CELLS],
            materials: vec![0; CELLS],
            tints: vec![0xffffff; CELLS],
            biomes: vec![u32::MAX; CELLS],
            overlays: vec![0; CELLS],
            overlay_heights: vec![MISSING_HEIGHT; CELLS],
            water_depth: vec![0; CELLS],
            supports: vec![0; CELLS],
            support_heights: vec![MISSING_HEIGHT; CELLS],
        }
    }
    pub fn gpu_words(&self) -> Vec<u32> {
        (0..CELLS)
            .flat_map(|i| {
                [
                    self.heights[i] as i32 as u32,
                    self.materials[i],
                    self.tints[i],
                    self.overlays[i],
                    self.water_depth[i],
                    self.supports[i],
                    self.overlay_heights[i] as i32 as u32,
                    self.coverage[i],
                ]
            })
            .collect()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Material {
    pub key: String,
    pub name: String,
    pub texture: String,
    pub tint: u32,
    pub approximate: bool,
    #[serde(default)]
    pub uv: [f32; 4],
    #[serde(default)]
    pub average: [f32; 4],
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RegionRef {
    pub rx: i32,
    pub rz: i32,
    pub url: String,
    pub sha256: String,
    pub bytes: usize,
    pub columns: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MapManifest {
    pub format_version: u32,
    pub name: String,
    pub bounds: [i32; 4], // min x/z, exclusive max x/z
    pub spawn: [i32; 3],
    pub source_sha256: String,
    pub catalog_version: String,
    pub materials: Vec<Material>,
    pub atlas: String,
    pub regions: Vec<RegionRef>,
    pub heights: String,
    pub heights_sha256: String,
    pub height_range: [i16; 2],
    pub approximations: Vec<String>,
}

fn write_u32(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_le_bytes());
}
fn read_u32(input: &mut &[u8]) -> Result<u32> {
    ensure!(input.len() >= 4, "truncated field");
    let v = u32::from_le_bytes(input[..4].try_into()?);
    *input = &input[4..];
    Ok(v)
}

// Each channel independently uses a constant, frame-of-reference, or palette mode.
fn encode_channel(values: &[u32], out: &mut Vec<u8>) -> Result<()> {
    ensure!(values.len() == CELLS, "invalid channel length");
    let min = *values.iter().min().context("empty channel")?;
    let max = *values.iter().max().unwrap();
    let width = (32 - (max - min).leading_zeros()) as u8;
    let mut palette = BTreeMap::new();
    for v in values {
        palette.entry(*v).or_insert(0u32);
    }
    let pwidth = (32 - (palette.len() as u32 - 1).leading_zeros()) as u8;
    let use_palette = palette.len() * 4 + (CELLS * pwidth as usize).div_ceil(8)
        < (CELLS * width as usize).div_ceil(8);
    out.push(if use_palette { 1 } else { 0 });
    let bits = if use_palette { pwidth } else { width };
    out.push(bits);
    if use_palette {
        write_u32(out, palette.len() as u32);
        for (i, (v, index)) in palette.iter_mut().enumerate() {
            *index = i as u32;
            write_u32(out, *v);
        }
    } else {
        write_u32(out, min);
    }
    let mut acc = 0u64;
    let mut available = 0u32;
    for v in values {
        let n = if use_palette { palette[v] } else { *v - min };
        acc |= (n as u64) << available;
        available += bits as u32;
        while available >= 8 {
            out.push(acc as u8);
            acc >>= 8;
            available -= 8;
        }
    }
    if available > 0 {
        out.push(acc as u8);
    }
    Ok(())
}

fn decode_channel(input: &mut &[u8]) -> Result<Vec<u32>> {
    ensure!(input.len() >= 2, "truncated channel");
    let mode = input[0];
    let bits = input[1];
    *input = &input[2..];
    ensure!(mode <= 1 && bits <= 32, "invalid channel encoding");
    let base = read_u32(input)?;
    let palette = if mode == 1 {
        ensure!(base > 0 && base as usize <= CELLS, "invalid palette size");
        (0..base)
            .map(|_| read_u32(input))
            .collect::<Result<Vec<_>>>()?
    } else {
        vec![]
    };
    let bytes = (CELLS * bits as usize).div_ceil(8);
    ensure!(input.len() >= bytes, "truncated packed channel");
    let packed = &input[..bytes];
    *input = &input[bytes..];
    let mask = (1u64 << bits) - 1;
    let mut acc = 0u64;
    let mut available = 0u32;
    let mut cursor = 0;
    let mut values = Vec::with_capacity(CELLS);
    for _ in 0..CELLS {
        while available < bits as u32 {
            acc |= (packed[cursor] as u64) << available;
            cursor += 1;
            available += 8;
        }
        let v = (acc & mask) as u32;
        acc >>= bits;
        available -= bits as u32;
        values.push(if mode == 1 {
            *palette
                .get(v as usize)
                .context("palette index out of range")?
        } else {
            base.checked_add(v).context("channel overflow")?
        });
    }
    Ok(values)
}

pub fn encode_region(r: &SurfaceRegion) -> Result<Vec<u8>> {
    let mut out = b"BSM1".to_vec();
    write_u32(&mut out, r.rx as u32);
    write_u32(&mut out, r.rz as u32);
    for field in [
        &r.coverage,
        &r.materials,
        &r.tints,
        &r.biomes,
        &r.overlays,
        &r.water_depth,
        &r.supports,
    ] {
        encode_channel(field, &mut out)?;
    }
    for field in [&r.heights, &r.overlay_heights, &r.support_heights] {
        encode_channel(
            &field
                .iter()
                .map(|v| (*v as i32 + 32768) as u32)
                .collect::<Vec<_>>(),
            &mut out,
        )?;
    }
    Ok(out)
}

pub fn decode_region(mut input: &[u8]) -> Result<SurfaceRegion> {
    ensure!(
        input.len() <= MAX_DECOMPRESSED && input.starts_with(b"BSM1"),
        "invalid region header or length"
    );
    input = &input[4..];
    let rx = read_u32(&mut input)? as i32;
    let rz = read_u32(&mut input)? as i32;
    let mut r = SurfaceRegion::empty(rx, rz);
    for field in [
        &mut r.coverage,
        &mut r.materials,
        &mut r.tints,
        &mut r.biomes,
        &mut r.overlays,
        &mut r.water_depth,
        &mut r.supports,
    ] {
        *field = decode_channel(&mut input)?;
    }
    for field in [
        &mut r.heights,
        &mut r.overlay_heights,
        &mut r.support_heights,
    ] {
        *field = decode_channel(&mut input)?
            .into_iter()
            .map(|v| {
                ensure!(v <= 65535, "invalid height");
                Ok((v as i32 - 32768) as i16)
            })
            .collect::<Result<_>>()?;
    }
    ensure!(input.is_empty(), "trailing region data");
    ensure!(r.coverage.iter().all(|v| *v <= 1), "invalid coverage");
    Ok(r)
}

pub fn decompress(data: &[u8], limit: usize) -> Result<Vec<u8>> {
    ensure!(
        data.len() <= 64 * 1024 * 1024 && limit <= 64 * 1024 * 1024,
        "compressed payload limit"
    );
    // Preflight the small Zstd frame header before ruzstd allocates its window.
    ensure!(
        data.len() >= 6 && data[..4] == [0x28, 0xb5, 0x2f, 0xfd],
        "invalid zstd frame"
    );
    let descriptor = data[4];
    ensure!(
        descriptor & 0x1b == 0,
        "unsupported zstd flags or dictionary"
    );
    let single = descriptor & 0x20 != 0;
    let mut cursor = 5;
    let mut window = 0u64;
    if !single {
        let wd = data[cursor];
        cursor += 1;
        let base = 1u64 << (10 + (wd >> 3));
        window = base + (base / 8) * u64::from(wd & 7);
    }
    let count = match descriptor >> 6 {
        0 => usize::from(single),
        1 => 2,
        2 => 4,
        _ => 8,
    };
    if count > 0 {
        let bytes = data
            .get(cursor..cursor + count)
            .context("truncated zstd header")?;
        let mut n = [0u8; 8];
        n[..count].copy_from_slice(bytes);
        let size = u64::from_le_bytes(n) + if count == 2 { 256 } else { 0 };
        ensure!(size <= limit as u64, "zstd content size limit");
        if single {
            window = size;
        }
    }
    ensure!(window <= 64 * 1024 * 1024, "zstd window limit");
    let mut decoder =
        ruzstd::decoding::StreamingDecoder::new(data).map_err(|e| anyhow::anyhow!("zstd: {e}"))?;
    let mut result = Vec::new();
    (&mut decoder)
        .take(limit as u64 + 1)
        .read_to_end(&mut result)?;
    if result.len() > limit {
        bail!("decompression limit exceeded");
    }
    if let Some(expected) = decoder.decoder.get_checksum_from_data() {
        ensure!(
            decoder.decoder.get_calculated_checksum() == Some(expected),
            "zstd checksum mismatch"
        );
    }
    ensure!(
        decoder.into_inner().is_empty(),
        "trailing zstd frames or data"
    );
    Ok(result)
}

/// Packed max-height hierarchy: 32 vec4<u32> descriptors followed by f32 data.
/// Descriptor fields are offset, width, height; descriptor 31.w holds level count.
pub fn height_pyramid(heights: &[f32], width: usize, height: usize) -> Vec<u32> {
    assert!(width > 0 && height > 0 && width * height <= 16 * 1024 * 1024);
    assert_eq!(heights.len(), width * height);
    assert!(heights.iter().all(|h| h.is_finite()));
    let mut words = vec![0u32; 128];
    let mut values = heights.to_vec();
    let (mut w, mut h, mut level) = (width, height, 0usize);
    loop {
        words[level * 4] = (words.len() - 128) as u32;
        words[level * 4 + 1] = w as u32;
        words[level * 4 + 2] = h as u32;
        words.extend(values.iter().map(|v| v.to_bits()));
        level += 1;
        if w == 1 && h == 1 {
            break;
        }
        let (nw, nh) = (w.div_ceil(2), h.div_ceil(2));
        let mut next = vec![-1e6f32; nw * nh];
        for z in 0..h {
            for x in 0..w {
                let at = z / 2 * nw + x / 2;
                next[at] = next[at].max(values[z * w + x]);
            }
        }
        values = next;
        (w, h) = (nw, nh);
    }
    words[127] = level as u32;
    words
}

/// Unit horizontal direction towards the sun, with +X east and +Z south.
/// Azimuth is degrees clockwise from north: N=0/360, E=90, S=180, W=270.
pub fn sun_direction(azimuth_degrees: f32) -> [f32; 2] {
    let angle = (azimuth_degrees.rem_euclid(360.) as f64).to_radians();
    [angle.sin(), -angle.cos()].map(|v| if v.abs() < 1e-7 { 0. } else { v as f32 })
}

/// Area-integrated artistic rim/contact lighting; neighbors are west/east/north/south.
/// Enumerating the four band intersections is independent of the WGSL union formula.
pub fn edge_relief_reference(
    y: f32,
    neighbors: [f32; 4],
    direction: [f32; 2],
    lo: [f32; 2],
    hi: [f32; 2],
    width: f32,
) -> [f32; 2] {
    let mut coverage = [0f64; 2];
    let mut rim = [0f64; 2];
    let mut contact = [0f64; 2];
    let max_direction = f64::from(direction[0].abs().max(direction[1].abs())).max(0.0001);
    for axis in 0..2 {
        let positive = direction[axis] >= 0.;
        let neighbor = neighbors[axis * 2 + usize::from(positive)];
        let delta = if neighbor < -900000. {
            0.
        } else {
            f64::from(y - neighbor)
        };
        let weight = f64::from(direction[axis].abs()) / max_direction;
        rim[axis] = delta.clamp(0., 1.) * weight;
        contact[axis] = (-delta).clamp(0., 1.) * weight;
        let start = if positive { 1. - f64::from(width) } else { 0. };
        coverage[axis] = ((f64::from(hi[axis]).min(start + f64::from(width))
            - f64::from(lo[axis]).max(start))
            / f64::from(hi[axis] - lo[axis]).max(0.000001))
        .clamp(0., 1.);
    }
    let mut result = [0f64; 2];
    for mask in 0..4 {
        let mut probability = 1.;
        let mut lit = [0f64; 2];
        let mut dark = [0f64; 2];
        for axis in 0..2 {
            if mask & (1 << axis) != 0 {
                probability *= coverage[axis];
                lit[axis] = rim[axis];
                dark[axis] = contact[axis];
            } else {
                probability *= 1. - coverage[axis];
            }
        }
        result[0] += probability * (0.55 * lit[0].max(lit[1]) + 0.25 * lit[0] * lit[1]);
        result[1] += probability * (0.28 * dark[0].max(dark[1]) + 0.10 * dark[0] * dark[1]);
    }
    result.map(|v| v as f32)
}

/// Independent f64 grid DDA oracle, without a hierarchy or boundary nudges.
pub fn ray_shadow_reference(
    heights: &[f32],
    size: [usize; 2],
    position: [f32; 2],
    y: f32,
    direction: [f32; 2],
    slope: f32,
) -> f32 {
    let start = position.map(f64::from);
    let d = direction.map(f64::from);
    let mut cell = start.map(|v| v.floor() as isize);
    let step = d.map(|v| {
        if v > 0. {
            1
        } else if v < 0. {
            -1
        } else {
            0
        }
    });
    let delta = d.map(|v| if v == 0. { f64::INFINITY } else { 1. / v.abs() });
    let mut next = [0f64; 2];
    for axis in 0..2 {
        next[axis] = if d[axis] == 0. {
            f64::INFINITY
        } else {
            let edge = cell[axis] + isize::from(step[axis] > 0);
            (edge as f64 - start[axis]) / d[axis]
        };
    }
    loop {
        let t = next[0].min(next[1]);
        for axis in 0..2 {
            if next[axis] <= t + 1e-10 {
                cell[axis] += step[axis];
                next[axis] += delta[axis];
            }
        }
        if cell[0] < 0 || cell[1] < 0 || cell[0] >= size[0] as isize || cell[1] >= size[1] as isize
        {
            return 0.;
        }
        if heights[cell[1] as usize * size[0] + cell[0] as usize] as f64
            > y as f64 + t * slope as f64 + 0.0001
        {
            return 1.;
        }
    }
}

pub fn shadow_reference(heights: &[i16], width: usize, height: usize) -> Vec<f32> {
    let horizon = horizon_reference(heights, width, height, SUN_STEP);
    heights
        .iter()
        .enumerate()
        .map(|(i, h)| {
            if *h == MISSING_HEIGHT {
                return 0.;
            }
            shadow_coverage_reference(
                &horizon,
                [width, height],
                [i % width, i / width],
                *h as f32 / 16.,
                SUN_STEP,
                [0.4999, 0.4999],
                [0.5001, 0.5001],
            )
        })
        .collect()
}

/// Cached NW diagonal horizon. Unlike a binary shadow mask, this retains enough
/// information to shade fractional top faces at any map zoom.
pub fn horizon_reference(heights: &[i16], width: usize, height: usize, slope: f32) -> Vec<f32> {
    assert_eq!(heights.len(), width * height);
    let mut result = vec![-1e6; heights.len()];
    for diagonal in 0..width + height - 1 {
        let (mut x, mut z) = if diagonal < width {
            (diagonal, 0)
        } else {
            (0, diagonal - width + 1)
        };
        let mut horizon = -1e6f32;
        while x < width && z < height {
            let i = z * width + x;
            horizon = (horizon - slope).max(-1e6);
            if heights[i] != MISSING_HEIGHT {
                let h = heights[i] as f32 / 16.;
                horizon = horizon.max(h);
            }
            result[i] = horizon;
            x += 1;
            z += 1;
        }
    }
    result
}

/// Exact top-face shadow area for a rectangular sample footprint within one
/// column. Each triangle sees a side-diagonal horizon and the shared NW horizon.
pub fn shadow_coverage_reference(
    horizon: &[f32],
    size: [usize; 2],
    at: [usize; 2],
    y: f32,
    slope: f32,
    lower: [f32; 2],
    upper: [f32; 2],
) -> f32 {
    let read = |dx: isize, dz: isize| {
        let x = at[0] as isize + dx;
        let z = at[1] as isize + dz;
        if x < 0 || z < 0 || x >= size[0] as isize || z >= size[1] as isize {
            -1e6
        } else {
            horizon[z as usize * size[0] + x as usize]
        }
    };
    let threshold = |h: f32| (h - y - 0.0001) / slope;
    let lit_half = |lo: [f32; 2], hi: [f32; 2], side: f32, diagonal: f32| {
        let x0 = lo[0].max(side);
        let x1 = hi[0].min(hi[1]);
        let y0 = lo[1].max(diagonal);
        if x1 <= x0 || hi[1] <= y0 {
            return 0.;
        }
        let split = y0.clamp(x0, x1);
        (split - x0) * (hi[1] - y0) + (x1 - split) * (hi[1] - (split + x1) * 0.5)
    };
    let nw = threshold(read(-1, -1));
    let lit = lit_half(lower, upper, threshold(read(-1, 0)), nw)
        + lit_half(
            [lower[1], lower[0]],
            [upper[1], upper[0]],
            threshold(read(0, -1)),
            nw,
        );
    (1. - lit / ((upper[0] - lower[0]) * (upper[1] - lower[1]))).clamp(0., 1.)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relief_only_at_steps_with_brighter_corners() {
        let nw = sun_direction(315.);
        let point = |neighbors, uv: [f32; 2]| {
            edge_relief_reference(1., neighbors, nw, uv, uv.map(|v| v + 0.01), 0.25)
        };
        assert_eq!(point([1.; 4], [0.01; 2]), [0.; 2]);
        assert_eq!(point([-1e6; 4], [0.01; 2]), [0.; 2]);
        assert_eq!(point([0.; 4], [0.5; 2]), [0.; 2]);
        let edge = point([0.; 4], [0.1, 0.5]);
        let corner = point([0.; 4], [0.1; 2]);
        assert!((edge[0] - 0.55).abs() < 1e-6);
        assert!((corner[0] - 0.8).abs() < 1e-6);
        assert_eq!(corner[1], 0.);
        let contact = point([2.; 4], [0.1; 2]);
        assert!((contact[1] - 0.38).abs() < 1e-6);
        assert_eq!(contact[0], 0.);
        let partial = point([0.5; 4], [0.1, 0.5]);
        assert!((partial[0] - edge[0] * 0.5).abs() < 1e-6);
    }

    #[test]
    fn relief_rotates_and_integrates_subpixel_width() {
        for azimuth in [0., 90., 135., 150., 180., 225., 270., 315., 330., 360.] {
            let d = sun_direction(azimuth);
            let opposite = sun_direction(azimuth + 180.);
            let a = edge_relief_reference(1., [0.; 4], d, [0.1; 2], [0.11; 2], 0.25);
            let b = edge_relief_reference(1., [0.; 4], opposite, [0.89; 2], [0.9; 2], 0.25);
            assert!((a[0] - b[0]).abs() < 1e-6);
        }
        for width in [0.05, 0.1, 0.25, 0.5] {
            let full =
                edge_relief_reference(1., [0.; 4], sun_direction(270.), [0.; 2], [1.; 2], width);
            assert!((full[0] - 0.55 * width).abs() < 1e-6);
            let outside = edge_relief_reference(
                1.,
                [0.; 4],
                sun_direction(270.),
                [width, 0.],
                [1.; 2],
                width,
            );
            assert_eq!(outside, [0.; 2]);
        }
        let north = edge_relief_reference(
            1.,
            [0.; 4],
            sun_direction(330.),
            [0.5, 0.1],
            [0.51, 0.11],
            0.25,
        );
        let west = edge_relief_reference(
            1.,
            [0.; 4],
            sun_direction(330.),
            [0.1, 0.5],
            [0.11, 0.51],
            0.25,
        );
        assert!(north[0] > west[0]);
    }

    #[test]
    fn azimuth_is_clockwise_from_north() {
        for (azimuth, expected) in [
            (0., [0., -1.]),
            (90., [1., 0.]),
            (180., [0., 1.]),
            (270., [-1., 0.]),
            (360., [0., -1.]),
        ] {
            assert_eq!(sun_direction(azimuth), expected);
        }
        let diagonal = std::f32::consts::FRAC_1_SQRT_2;
        for (azimuth, expected) in [
            (45., [diagonal, -diagonal]),
            (135., [diagonal, diagonal]),
            (225., [-diagonal, diagonal]),
            (315., [-diagonal, -diagonal]),
            (330., [-0.5, -3f32.sqrt() / 2.]),
        ] {
            for (actual, expected) in sun_direction(azimuth).into_iter().zip(expected) {
                assert!((actual - expected).abs() < 1e-6);
            }
        }
        for angle in [0., 1., 90., 180., 270., 315., 330., 359.] {
            for turns in [-3., -1., 1., 3.] {
                assert_eq!(sun_direction(angle), sun_direction(angle + turns * 360.));
            }
        }
    }

    #[test]
    fn height_tree_and_shadow_reach() {
        let values: Vec<f32> = (0..17 * 11)
            .map(|i| {
                if i % 7 == 0 {
                    -1e6
                } else {
                    (i % 19) as f32 - 10.
                }
            })
            .collect();
        let tree = height_pyramid(&values, 17, 11);
        for level in 0..tree[127] as usize {
            let (offset, w, h) = (
                tree[level * 4] as usize,
                tree[level * 4 + 1] as usize,
                tree[level * 4 + 2] as usize,
            );
            let span = 1 << level;
            for z in 0..h {
                for x in 0..w {
                    let mut expected = -1e6f32;
                    for zz in z * span..((z + 1) * span).min(11) {
                        for xx in x * span..((x + 1) * span).min(17) {
                            expected = expected.max(values[zz * 17 + xx]);
                        }
                    }
                    assert_eq!(f32::from_bits(tree[128 + offset + z * w + x]), expected);
                }
            }
        }
        let mut ledge = vec![0.; 32];
        ledge[16] = 10.;
        let slope = 60f32.to_radians().tan();
        assert_eq!(
            ray_shadow_reference(&ledge, [32, 1], [10.3, 0.5], 0., sun_direction(90.), slope),
            1.
        );
        assert_eq!(
            ray_shadow_reference(&ledge, [32, 1], [10.1, 0.5], 0., sun_direction(90.), slope),
            0.
        );
        assert_eq!(
            ray_shadow_reference(&ledge, [32, 1], [10.3, 0.5], 0., sun_direction(270.), slope),
            0.
        );
    }
    #[test]
    fn constants_and_missing_roundtrip() {
        let r = SurfaceRegion::empty(-2, 3);
        let b = encode_region(&r).unwrap();
        assert!(b.len() < 100);
        assert_eq!(decode_region(&b).unwrap(), r);
    }
    #[test]
    fn mixed_all_fields_roundtrip() {
        let mut r = SurfaceRegion::empty(-1, -1);
        let mut seed = 9u32;
        for i in 0..CELLS {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            r.materials[i] = seed % 7;
            r.heights[i] = (seed % 6000) as i16 - 1024;
            r.biomes[i] = seed;
            r.overlays[i] = seed % 3;
            r.coverage[i] = (i % 3 != 0) as u32;
            r.tints[i] = seed & 0xffffff;
            r.water_depth[i] = seed % 255;
            r.support_heights[i] = -1024;
            r.overlay_heights[i] = 4000;
            r.supports[i] = seed % 19;
        }
        let raw = encode_region(&r).unwrap();
        let packed = zstd::encode_all(raw.as_slice(), 3).unwrap();
        assert_eq!(
            decode_region(&decompress(&packed, MAX_DECOMPRESSED).unwrap()).unwrap(),
            r
        );
    }
    #[test]
    fn corrupt_and_bounds() {
        let raw = encode_region(&SurfaceRegion::empty(0, 0)).unwrap();
        for n in [0, 3, 11, raw.len() - 1] {
            assert!(decode_region(&raw[..n]).is_err());
        }
        let packed = zstd::encode_all(vec![0u8; 10000].as_slice(), 3).unwrap();
        assert!(decompress(&packed, 100).is_err());
        assert!(decompress(b"bad", 100).is_err());
        assert!(decompress(&[0x28, 0xb5, 0x2f, 0xfd, 0, 255], 100).is_err());
        let mut trailing = packed.clone();
        trailing.extend_from_slice(b"extra");
        assert!(decompress(&trailing, 10000).is_err());
    }
    #[test]
    fn flat_and_column_shadows() {
        let mut h = vec![0; 16 * 16];
        assert!(shadow_reference(&h, 16, 16).iter().all(|s| *s == 0.));
        h[0] = 160;
        let s = shadow_reference(&h, 16, 16);
        for n in 1..=4 {
            assert_eq!(s[n * 17], 1.);
        }
        assert_eq!(s[5 * 17], 0.);
        assert!((10. / 3f32.sqrt() - 5.7735).abs() < 0.001);
    }
    #[test]
    fn boundary_and_missing_shadow() {
        let mut h = vec![0; 300 * 300];
        h[254 * 300 + 254] = 160;
        h[255 * 300 + 255] = MISSING_HEIGHT;
        assert_eq!(shadow_reference(&h, 300, 300)[256 * 300 + 256], 1.);
    }

    #[test]
    fn single_block_ledge_casts_fractional_shadow() {
        let mut heights = vec![0; 8 * 8];
        for z in 0..8 {
            for x in 0..4 {
                heights[z * 8 + x] = 16;
            }
        }
        for elevation in [30f32, 45., 60.] {
            let slope = elevation.to_radians().tan() * std::f32::consts::SQRT_2;
            let horizon = horizon_reference(&heights, 8, 8, slope);
            let fraction =
                shadow_coverage_reference(&horizon, [8, 8], [4, 4], 0., slope, [0., 0.], [1., 1.]);
            assert!((fraction - (1. / slope).min(1.)).abs() < 0.0002);
            assert_eq!(
                shadow_coverage_reference(&horizon, [8, 8], [3, 4], 1., slope, [0., 0.], [1., 1.]),
                0.
            );
        }
    }

    #[test]
    fn horizon_coverage_agrees_with_independent_ray_walk() {
        let (w, h) = (19usize, 23usize);
        let mut seed = 718u32;
        let heights: Vec<i16> = (0..w * h)
            .map(|_| {
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                if seed.is_multiple_of(11) {
                    MISSING_HEIGHT
                } else {
                    (seed % 320) as i16 - 96
                }
            })
            .collect();
        for elevation in [30f32, 45., 60.] {
            let slope = elevation.to_radians().tan() * std::f32::consts::SQRT_2;
            let horizon = horizon_reference(&heights, w, h, slope);
            for z in 0..h {
                for x in 0..w {
                    if heights[z * w + x] == MISSING_HEIGHT {
                        continue;
                    }
                    let y = heights[z * w + x] as f32 / 16.;
                    let mut shadowed = 0usize;
                    for v in 0..24 {
                        for u in 0..24 {
                            let uv = [(u as f32 + 0.5) / 24., (v as f32 + 0.5) / 24.];
                            let (mut xx, mut zz) = (x as isize, z as isize);
                            let (mut tx, mut tz) = (uv[0], uv[1]);
                            loop {
                                let distance = tx.min(tz);
                                if tx <= distance {
                                    xx -= 1;
                                    tx += 1.;
                                }
                                if tz <= distance {
                                    zz -= 1;
                                    tz += 1.;
                                }
                                if xx < 0 || zz < 0 {
                                    break;
                                }
                                let sample = heights[zz as usize * w + xx as usize];
                                if sample != MISSING_HEIGHT
                                    && sample as f32 / 16. > y + distance * slope + 0.0001
                                {
                                    shadowed += 1;
                                    break;
                                }
                            }
                        }
                    }
                    let actual = shadow_coverage_reference(
                        &horizon,
                        [w, h],
                        [x, z],
                        y,
                        slope,
                        [0., 0.],
                        [1., 1.],
                    );
                    assert!(
                        (actual - shadowed as f32 / 576.).abs() < 0.045,
                        "coverage at {x},{z}: {actual}"
                    );
                }
            }
        }
    }
}
