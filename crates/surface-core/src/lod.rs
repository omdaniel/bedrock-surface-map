//! Version-one, independently decodable 128-square native LOD pages.
//!
//! Codecs accept raw bytes. Transport uses one Zstd frame and the existing
//! bounded `decompress` function. Heights are signed sixteenths of a block;
//! colors are UNORM16 in the renderer's existing (non-sRGB-decoded) working space.
use crate::terrain::{Column, UNKNOWN};
use crate::{
    MISSING_HEIGHT, Material, SurfaceRegion, decode_channel, encode_channel, read_u32, write_u32,
};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};

mod appearance;
mod metadata;
pub use appearance::{appearance_colors, validate_materials};
pub use metadata::*;

pub const TILE_SIDE: usize = 128;
pub const TILE_CELLS: usize = TILE_SIDE * TILE_SIDE;
pub const MAX_LEVEL: u8 = 16;
pub const WORLD_LIMIT: i32 = 8_388_608;
pub const MAX_TILE_BYTES: usize = 2 * 1024 * 1024;
pub const APPEARANCE_VERSION: &str = "1";
pub const PRESENT: u16 = 1;
pub const EMPTY: u16 = 2;
pub const UNKNOWN_FLAG: u16 = 4;
pub const OUTSIDE: u16 = 8;
pub const WATER: u16 = 16;
pub const ALL_FLAGS: u16 = PRESENT | EMPTY | UNKNOWN_FLAG | OUTSIDE | WATER;
pub const OUTSIDE_COLUMN: Column = [3, -32768, 0, 0xffffff, -1, 0, -32768, 0, 0, -32768];

/// Reject oversized transport, decoded content and decoder window allocations
/// before constructing ruzstd. Concatenated frames and invalid checksums fail too.
pub fn decompress_lod(data: &[u8]) -> Result<Vec<u8>> {
    ensure!(data.len() <= MAX_TILE_BYTES, "compressed LOD byte limit");
    crate::decompress_with_window_limit(data, MAX_TILE_BYTES, MAX_TILE_BYTES as u64)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TileKey {
    pub level: u8,
    pub x: i32,
    pub z: i32,
}

impl TileKey {
    pub fn new(level: u8, x: i32, z: i32) -> Result<Self> {
        let key = Self { level, x, z };
        key.validate()?;
        Ok(key)
    }
    pub fn validate(self) -> Result<()> {
        ensure!(self.level <= MAX_LEVEL, "LOD level limit");
        let span = 128i64 << self.level;
        for v in [self.x, self.z] {
            let origin = i64::from(v) * span;
            ensure!(
                origin >= -i64::from(WORLD_LIMIT) && origin + span <= i64::from(WORLD_LIMIT),
                "tile coordinate limit"
            );
        }
        Ok(())
    }
    pub fn span(self) -> Result<i32> {
        self.validate()?;
        Ok(128 << self.level)
    }
    pub fn bounds(self) -> Result<[i32; 4]> {
        let span = self.span()?;
        let x = self.x * span;
        let z = self.z * span;
        Ok([x, z, x + span, z + span])
    }
    pub fn at(level: u8, x: i32, z: i32) -> Result<Self> {
        ensure!(level <= MAX_LEVEL, "LOD level limit");
        let span = 128 << level;
        Self::new(level, x.div_euclid(span), z.div_euclid(span))
    }
    pub fn parent(self) -> Result<Self> {
        self.validate()?;
        ensure!(self.level < MAX_LEVEL, "no parent above maximum level");
        Self::new(self.level + 1, self.x.div_euclid(2), self.z.div_euclid(2))
    }
    /// Children in row-major order: NW, NE, SW, SE.
    pub fn children(self) -> Result<[Self; 4]> {
        self.validate()?;
        ensure!(self.level > 0, "detail tile has no children");
        Ok([
            Self::new(self.level - 1, self.x * 2, self.z * 2)?,
            Self::new(self.level - 1, self.x * 2 + 1, self.z * 2)?,
            Self::new(self.level - 1, self.x * 2, self.z * 2 + 1)?,
            Self::new(self.level - 1, self.x * 2 + 1, self.z * 2 + 1)?,
        ])
    }
}

pub fn validate_bounds(bounds: [i32; 4]) -> Result<()> {
    ensure!(
        bounds[0] < bounds[2] && bounds[1] < bounds[3],
        "empty or inverted bounds"
    );
    ensure!(
        bounds
            .iter()
            .all(|v| (-WORLD_LIMIT..=WORLD_LIMIT).contains(v)),
        "world coordinate limit"
    );
    Ok(())
}

/// Smallest common level with at most one root per sign quadrant.
/// Origin crossings have up to four roots because parents use floor division.
pub fn root_keys(bounds: [i32; 4]) -> Result<Vec<TileKey>> {
    validate_bounds(bounds)?;
    for level in 0..=MAX_LEVEL {
        let lo = TileKey::at(level, bounds[0], bounds[1])?;
        let hi = TileKey::at(level, bounds[2] - 1, bounds[3] - 1)?;
        let fits = |lo: i32, hi: i32| lo == hi || (lo == -1 && hi == 0);
        if fits(lo.x, hi.x) && fits(lo.z, hi.z) {
            let mut keys = Vec::new();
            for z in lo.z..=hi.z {
                for x in lo.x..=hi.x {
                    keys.push(TileKey::new(level, x, z)?);
                }
            }
            return Ok(keys);
        }
    }
    anyhow::bail!("bounds exceed four level-16 roots")
}

fn header(out: &mut Vec<u8>, magic: &[u8; 4], key: TileKey) {
    out.extend_from_slice(magic);
    out.extend_from_slice(&[key.level, 0, 0, 0]);
    write_u32(out, key.x as u32);
    write_u32(out, key.z as u32);
}

fn decode_header(input: &mut &[u8], magic: &[u8; 4]) -> Result<TileKey> {
    ensure!(
        input.len() >= 16 && input.len() <= MAX_TILE_BYTES,
        "tile byte limit or truncated header"
    );
    ensure!(
        &input[..4] == magic && input[5..8] == [0, 0, 0],
        "invalid tile magic, version or reserved bytes"
    );
    let level = input[4];
    *input = &input[8..];
    TileKey::new(level, read_u32(input)? as i32, read_u32(input)? as i32)
}

/// Exact source fields in the same order as `terrain::Column`: coverage, height,
/// material, tint, biome, overlay, overlay height, depth, support, support height.
/// Coverage 3 is exclusively the LOD out-of-bounds marker. No source field is discarded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DetailTile {
    pub key: TileKey,
    pub columns: Vec<Column>,
}

impl DetailTile {
    pub fn unknown(key: TileKey) -> Result<Self> {
        key.validate()?;
        ensure!(key.level == 0, "detail requires level zero");
        Ok(Self {
            key,
            columns: vec![UNKNOWN; TILE_CELLS],
        })
    }
    pub fn from_region(region: &SurfaceRegion, key: TileKey) -> Result<Self> {
        let mut tile = Self::unknown(key)?;
        ensure!(
            key.x.div_euclid(2) == region.rx && key.z.div_euclid(2) == region.rz,
            "tile outside source region"
        );
        ensure!(
            [
                region.coverage.len(),
                region.heights.len(),
                region.materials.len(),
                region.tints.len(),
                region.biomes.len(),
                region.overlays.len(),
                region.overlay_heights.len(),
                region.water_depth.len(),
                region.supports.len(),
                region.support_heights.len(),
            ]
            .into_iter()
            .all(|len| len == crate::CELLS),
            "invalid source region shape"
        );
        for (i, column) in tile.columns.iter_mut().enumerate() {
            let j = (key.z.rem_euclid(2) as usize * 128 + i / 128) * 256
                + key.x.rem_euclid(2) as usize * 128
                + i % 128;
            *column = [
                region.coverage[j] as i32,
                region.heights[j] as i32,
                region.materials[j] as i32,
                region.tints[j] as i32,
                region.biomes[j] as i32,
                region.overlays[j] as i32,
                region.overlay_heights[j] as i32,
                region.water_depth[j] as i32,
                region.supports[j] as i32,
                region.support_heights[j] as i32,
            ];
        }
        tile.validate()?;
        Ok(tile)
    }
    pub fn validate(&self) -> Result<()> {
        self.key.validate()?;
        ensure!(
            self.key.level == 0 && self.columns.len() == TILE_CELLS,
            "detail tile shape"
        );
        for c in &self.columns {
            ensure!((0..=3).contains(&c[0]), "invalid detail coverage");
            for i in [1, 6, 9] {
                ensure!(i16::try_from(c[i]).is_ok(), "invalid detail height");
            }
            for i in [2, 5, 8] {
                ensure!((0..65536).contains(&c[i]), "invalid detail material");
            }
            ensure!(
                (0..=0xffffff).contains(&c[3]) && (0..=384).contains(&c[7]),
                "invalid detail attributes"
            );
            ensure!(
                c[0] != 1 || (c[1] != i32::from(MISSING_HEIGHT) && c[2] != 0),
                "present sample missing surface"
            );
        }
        Ok(())
    }
    pub fn encode(&self) -> Result<Vec<u8>> {
        self.validate()?;
        let mut out = Vec::new();
        header(&mut out, b"BSD1", self.key);
        for field in 0..10 {
            let channel = self
                .columns
                .iter()
                .map(|c| (c[field] as u32) ^ 0x8000_0000)
                .collect::<Vec<_>>();
            encode_channel(&channel, &mut out)?;
        }
        ensure!(out.len() <= MAX_TILE_BYTES, "detail byte limit");
        Ok(out)
    }
    pub fn decode(mut input: &[u8]) -> Result<Self> {
        let key = decode_header(&mut input, b"BSD1")?;
        let mut result = Self::unknown(key)?;
        for field in 0..10 {
            for (c, v) in result
                .columns
                .iter_mut()
                .zip(decode_channel(&mut input, TILE_CELLS)?)
            {
                c[field] = (v ^ 0x8000_0000) as i32;
            }
        }
        ensure!(input.is_empty(), "trailing detail bytes");
        result.validate()?;
        Ok(result)
    }
    pub fn gpu_words(&self) -> Vec<u32> {
        self.columns
            .iter()
            .flat_map(|c| [c[1], c[2], c[3], c[5], c[7], c[8], c[6], c[0]].map(|v| v as u32))
            .collect()
    }
}

pub fn column_flags(c: &Column) -> u16 {
    match c[0] {
        1 => PRESENT | if c[7] > 0 { WATER } else { 0 },
        2 => EMPTY,
        3 => OUTSIDE,
        _ => UNKNOWN_FLAG,
    }
}

/// Exactly 24 bytes per sample, with no padding or platform-dependent fields.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SummarySample {
    pub original: [u16; 3],
    pub vivid: [u16; 3],
    pub mean_height: i16,
    pub min_height: i16,
    pub max_height: i16,
    pub present_fraction: u8,
    pub empty_fraction: u8,
    pub unknown_fraction: u8,
    pub water_fraction: u8,
    pub flags: u16,
}

impl SummarySample {
    pub fn absent(flags: u16) -> Self {
        Self {
            original: [0; 3],
            vivid: [0; 3],
            mean_height: MISSING_HEIGHT,
            min_height: MISSING_HEIGHT,
            max_height: MISSING_HEIGHT,
            present_fraction: 0,
            empty_fraction: if flags & EMPTY != 0 { 255 } else { 0 },
            unknown_fraction: if flags & UNKNOWN_FLAG != 0 { 255 } else { 0 },
            water_fraction: 0,
            flags,
        }
    }
    pub fn validate(&self) -> Result<()> {
        validate_heights(
            self.mean_height,
            self.min_height,
            self.max_height,
            self.flags,
        )?;
        for (fraction, flag) in [
            (self.present_fraction, PRESENT),
            (self.empty_fraction, EMPTY),
            (self.unknown_fraction, UNKNOWN_FLAG),
            (self.water_fraction, WATER),
        ] {
            ensure!(
                fraction == 0 || self.flags & flag != 0,
                "fraction without coverage flag"
            );
        }
        ensure!(
            u16::from(self.present_fraction)
                + u16::from(self.empty_fraction)
                + u16::from(self.unknown_fraction)
                <= 257,
            "coverage fraction sum"
        );
        ensure!(
            self.water_fraction <= self.present_fraction,
            "water fraction exceeds present fraction"
        );
        Ok(())
    }
    pub fn gpu_words(self) -> [u32; 6] {
        [
            pack(self.original[0], self.original[1]),
            pack(self.original[2], self.vivid[0]),
            pack(self.vivid[1], self.vivid[2]),
            pack(self.mean_height as u16, self.min_height as u16),
            u32::from(self.max_height as u16)
                | (u32::from(self.present_fraction) << 16)
                | (u32::from(self.empty_fraction) << 24),
            u32::from(self.unknown_fraction)
                | (u32::from(self.water_fraction) << 8)
                | (u32::from(self.flags) << 16),
        ]
    }
    fn from_words(w: [u32; 6]) -> Self {
        Self {
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
    }
    /// Equal-area reduction. Quantized fractions weight means; a surviving present
    /// flag gets a minimum weight of one. Extrema and flags never depend on rounding.
    pub fn reduce(samples: [Self; 4]) -> Self {
        let flags = samples.iter().fold(0, |v, s| v | s.flags);
        let mut result = Self::absent(flags);
        let fraction = |get: fn(&Self) -> u8| -> u8 {
            ((samples.iter().map(|s| u16::from(get(s))).sum::<u16>() + 2) / 4) as u8
        };
        result.present_fraction = fraction(|s| s.present_fraction);
        result.empty_fraction = fraction(|s| s.empty_fraction);
        result.unknown_fraction = fraction(|s| s.unknown_fraction);
        result.water_fraction = fraction(|s| s.water_fraction);
        // Independent rounding can exceed one full sample after several levels.
        // Remove excess from the largest category without clearing coverage flags.
        let mut coverage = [
            result.present_fraction,
            result.empty_fraction,
            result.unknown_fraction,
        ];
        let total: u16 = coverage.iter().map(|v| u16::from(*v)).sum();
        if total > 255 {
            let largest = coverage.iter_mut().max().unwrap();
            *largest = u16::from(*largest).saturating_sub(total - 255) as u8;
        }
        [
            result.present_fraction,
            result.empty_fraction,
            result.unknown_fraction,
        ] = coverage;
        result.water_fraction = result.water_fraction.min(result.present_fraction);
        let mut weight = 0i64;
        let mut mean = 0i64;
        let mut original = [0i64; 3];
        let mut vivid = [0i64; 3];
        let mut min = i16::MAX;
        let mut max = i16::MIN;
        for s in samples.into_iter().filter(|s| s.flags & PRESENT != 0) {
            let w = i64::from(s.present_fraction.max(1));
            weight += w;
            mean += i64::from(s.mean_height) * w;
            min = min.min(s.min_height);
            max = max.max(s.max_height);
            for i in 0..3 {
                original[i] += i64::from(s.original[i]) * w;
                vivid[i] += i64::from(s.vivid[i]) * w;
            }
        }
        if weight > 0 {
            result.mean_height = (mean as f64 / weight as f64).round() as i16;
            result.min_height = min;
            result.max_height = max;
            result.original = original.map(|v| ((v + weight / 2) / weight) as u16);
            result.vivid = vivid.map(|v| ((v + weight / 2) / weight) as u16);
        }
        result
    }
}

fn pack(lo: u16, hi: u16) -> u32 {
    u32::from(lo) | (u32::from(hi) << 16)
}

fn validate_heights(mean: i16, min: i16, max: i16, flags: u16) -> Result<()> {
    ensure!(
        flags != 0 && flags & !ALL_FLAGS == 0 && (flags & WATER == 0 || flags & PRESENT != 0),
        "invalid height coverage flags"
    );
    if flags & PRESENT != 0 {
        ensure!(
            min != MISSING_HEIGHT && min <= mean && mean <= max,
            "invalid present extrema"
        );
    } else {
        ensure!(
            [mean, min, max] == [MISSING_HEIGHT; 3],
            "absent sample has height"
        );
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SummaryTile {
    pub key: TileKey,
    pub samples: Vec<SummarySample>,
}

impl SummaryTile {
    /// A level-zero intermediate is useful to build parents, but is not encodable.
    pub fn from_detail(detail: &DetailTile, materials: &[Material]) -> Result<Self> {
        detail.validate()?;
        validate_materials(materials)?;
        let mut samples = Vec::with_capacity(TILE_CELLS);
        for c in &detail.columns {
            for i in [2, 5, 8] {
                ensure!(
                    (c[i] as usize) < materials.len(),
                    "material outside catalog"
                );
            }
            let flags = column_flags(c);
            let mut s = SummarySample::absent(flags);
            if flags & PRESENT != 0 {
                let [original, vivid] = appearance_colors(c, materials)?;
                s.original = original.map(|v| (v.clamp(0., 1.) * 65535.).round() as u16);
                s.vivid = vivid.map(|v| (v.clamp(0., 1.) * 65535.).round() as u16);
                s.mean_height = c[1] as i16;
                s.min_height = c[1] as i16;
                s.max_height = c[1] as i16;
                s.present_fraction = 255;
                s.water_fraction = if flags & WATER != 0 { 255 } else { 0 };
            }
            samples.push(s);
        }
        Ok(Self {
            key: detail.key,
            samples,
        })
    }
    pub fn from_children(key: TileKey, children: [&Self; 4]) -> Result<Self> {
        let keys = key.children()?;
        for i in 0..4 {
            children[i].validate()?;
            ensure!(children[i].key == keys[i], "summary child key mismatch");
        }
        let sample = |x: usize, z: usize| {
            children[(z / 128) * 2 + x / 128].samples[(z % 128) * 128 + x % 128]
        };
        let mut samples = Vec::with_capacity(TILE_CELLS);
        for z in 0..128 {
            for x in 0..128 {
                samples.push(SummarySample::reduce([
                    sample(x * 2, z * 2),
                    sample(x * 2 + 1, z * 2),
                    sample(x * 2, z * 2 + 1),
                    sample(x * 2 + 1, z * 2 + 1),
                ]));
            }
        }
        Ok(Self { key, samples })
    }
    /// Missing source area is unknown inside map bounds, outside everywhere else.
    pub fn absent(key: TileKey, bounds: [i32; 4]) -> Result<Self> {
        validate_bounds(bounds)?;
        let origin = key.bounds()?;
        let step = 1i64 << key.level;
        let mut samples = Vec::with_capacity(TILE_CELLS);
        for z in 0..128 {
            for x in 0..128 {
                let sx = i64::from(origin[0]) + x * step;
                let sz = i64::from(origin[1]) + z * step;
                let width =
                    ((sx + step).min(i64::from(bounds[2])) - sx.max(i64::from(bounds[0]))).max(0);
                let height =
                    ((sz + step).min(i64::from(bounds[3])) - sz.max(i64::from(bounds[1]))).max(0);
                let area = width * height;
                let total = step * step;
                let flags = if area > 0 { UNKNOWN_FLAG } else { 0 }
                    | if area < total { OUTSIDE } else { 0 };
                let mut s = SummarySample::absent(flags);
                s.unknown_fraction = ((area * 255 + total / 2) / total) as u8;
                samples.push(s);
            }
        }
        Ok(Self { key, samples })
    }
    pub fn validate(&self) -> Result<()> {
        self.key.validate()?;
        ensure!(self.samples.len() == TILE_CELLS, "summary tile shape");
        for s in &self.samples {
            s.validate()?;
        }
        Ok(())
    }
    pub fn encode(&self) -> Result<Vec<u8>> {
        self.validate()?;
        ensure!(
            self.key.level > 0,
            "summary transport requires coarse level"
        );
        let mut out = Vec::with_capacity(16 + TILE_CELLS * 24);
        header(&mut out, b"BSS1", self.key);
        for word in self.gpu_words() {
            write_u32(&mut out, word);
        }
        Ok(out)
    }
    pub fn decode(mut input: &[u8]) -> Result<Self> {
        let key = decode_header(&mut input, b"BSS1")?;
        ensure!(
            key.level > 0 && input.len() == TILE_CELLS * 24,
            "summary shape or level"
        );
        let mut samples = Vec::with_capacity(TILE_CELLS);
        for _ in 0..TILE_CELLS {
            let mut words = [0; 6];
            for w in &mut words {
                *w = read_u32(&mut input)?;
            }
            samples.push(SummarySample::from_words(words));
        }
        let tile = Self { key, samples };
        tile.validate()?;
        Ok(tile)
    }
    pub fn gpu_words(&self) -> Vec<u32> {
        self.samples.iter().flat_map(|s| s.gpu_words()).collect()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HeightSample {
    pub mean_height: i16,
    pub min_height: i16,
    pub max_height: i16,
    pub flags: u16,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HeightTile {
    pub key: TileKey,
    pub samples: Vec<HeightSample>,
}

impl HeightTile {
    pub fn from_detail(tile: &DetailTile) -> Result<Self> {
        tile.validate()?;
        Ok(Self {
            key: tile.key,
            samples: tile
                .columns
                .iter()
                .map(|c| {
                    let h = if c[0] == 1 {
                        c[1] as i16
                    } else {
                        MISSING_HEIGHT
                    };
                    HeightSample {
                        mean_height: h,
                        min_height: h,
                        max_height: h,
                        flags: column_flags(c),
                    }
                })
                .collect(),
        })
    }
    pub fn from_summary(tile: &SummaryTile) -> Result<Self> {
        tile.validate()?;
        Ok(Self {
            key: tile.key,
            samples: tile
                .samples
                .iter()
                .map(|s| HeightSample {
                    mean_height: s.mean_height,
                    min_height: s.min_height,
                    max_height: s.max_height,
                    flags: s.flags,
                })
                .collect(),
        })
    }
    pub fn validate(&self) -> Result<()> {
        self.key.validate()?;
        ensure!(self.samples.len() == TILE_CELLS, "height tile shape");
        for s in &self.samples {
            validate_heights(s.mean_height, s.min_height, s.max_height, s.flags)?;
            if self.key.level == 0 {
                ensure!(
                    s.min_height == s.mean_height
                        && s.max_height == s.mean_height
                        && (s.flags & !WATER).count_ones() == 1,
                    "detail height is not exact"
                );
            }
        }
        Ok(())
    }
    pub fn encode(&self) -> Result<Vec<u8>> {
        self.validate()?;
        let mut out = Vec::new();
        header(&mut out, b"BSH1", self.key);
        for word in self.gpu_words() {
            write_u32(&mut out, word);
        }
        Ok(out)
    }
    pub fn decode(mut input: &[u8]) -> Result<Self> {
        let key = decode_header(&mut input, b"BSH1")?;
        let words = if key.level == 0 { 1 } else { 2 };
        ensure!(input.len() == TILE_CELLS * words * 4, "height page length");
        let mut samples = Vec::with_capacity(TILE_CELLS);
        for _ in 0..TILE_CELLS {
            let w = read_u32(&mut input)?;
            let h = w as i16;
            let extent = if words == 2 {
                read_u32(&mut input)?
            } else {
                pack(h as u16, h as u16)
            };
            samples.push(HeightSample {
                mean_height: h,
                min_height: extent as i16,
                max_height: (extent >> 16) as i16,
                flags: (w >> 16) as u16,
            });
        }
        let tile = Self { key, samples };
        tile.validate()?;
        Ok(tile)
    }
    pub fn gpu_words(&self) -> Vec<u32> {
        let mut words = Vec::with_capacity(TILE_CELLS * if self.key.level == 0 { 1 } else { 2 });
        for s in &self.samples {
            words.push(pack(s.mean_height as u16, s.flags));
            if self.key.level > 0 {
                words.push(pack(s.min_height as u16, s.max_height as u16));
            }
        }
        words
    }
}

#[cfg(test)]
mod tests;
