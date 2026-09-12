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

pub fn shadow_reference(heights: &[i16], width: usize, height: usize) -> Vec<f32> {
    assert_eq!(heights.len(), width * height);
    let mut result = vec![0.; heights.len()];
    for diagonal in 0..width + height - 1 {
        let (mut x, mut z) = if diagonal < width {
            (diagonal, 0)
        } else {
            (0, diagonal - width + 1)
        };
        let mut horizon = -1e6f32;
        while x < width && z < height {
            let i = z * width + x;
            horizon -= SUN_STEP;
            if heights[i] != MISSING_HEIGHT {
                let h = heights[i] as f32 / 16.;
                result[i] = if horizon > h + 0.05 { 1. } else { 0. };
                horizon = horizon.max(h);
            }
            x += 1;
            z += 1;
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
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
}
