//! Live surface transport. Columns are complete replacements, never edit commands.
use crate::{SurfaceRegion, decode_channel, encode_channel, read_u32, write_u32};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub const RULES_VERSION: u32 = 1;
pub const CHUNK_CELLS: usize = 256;
pub const MAX_REQUEST_BYTES: usize = 256 * 1024;
// coverage (0 unknown, 1 surface, 2 verified empty), top, material, RGB, biome,
// overlay material, overlay top, water depth, support material, support top.
pub type Column = [i32; 10];
pub const UNKNOWN: Column = [0, -32768, 0, 0xffffff, -1, 0, -32768, 0, 0, -32768];
pub const EMPTY: Column = [2, -32768, 0, 0xffffff, -1, 0, -32768, 0, 0, -32768];

/// Patch leaves and only their ancestors. Returned word ranges can be uploaded as rows.
pub fn patch_height_tree(
    tree: &mut [u32],
    x: usize,
    z: usize,
    width: usize,
    height: usize,
    values: &[f32],
) -> Result<Vec<(usize, usize)>> {
    ensure!(
        tree.len() >= 129 && width > 0 && height > 0 && values.len() == width * height,
        "height patch shape"
    );
    let tw = tree[1] as usize;
    let th = tree[2] as usize;
    ensure!(
        x.checked_add(width).is_some_and(|v| v <= tw)
            && z.checked_add(height).is_some_and(|v| v <= th)
            && values.iter().all(|v| v.is_finite()),
        "height patch bounds"
    );
    let levels = tree[127] as usize;
    ensure!((1..=25).contains(&levels), "height tree levels");
    let mut ranges = Vec::new();
    for row in 0..height {
        let start = 128 + tree[0] as usize + (z + row) * tw + x;
        ensure!(start + width <= tree.len(), "height tree leaf bounds");
        for (dst, src) in tree[start..start + width]
            .iter_mut()
            .zip(&values[row * width..(row + 1) * width])
        {
            *dst = src.to_bits();
        }
        ranges.push((start, width));
    }
    let (mut x0, mut z0, mut x1, mut z1) = (x, z, x + width, z + height);
    for level in 1..levels {
        x0 /= 2;
        z0 /= 2;
        x1 = x1.div_ceil(2);
        z1 = z1.div_ceil(2);
        let prev = 128 + tree[(level - 1) * 4] as usize;
        let pw = tree[(level - 1) * 4 + 1] as usize;
        let ph = tree[(level - 1) * 4 + 2] as usize;
        let offset = 128 + tree[level * 4] as usize;
        let lw = tree[level * 4 + 1] as usize;
        ensure!(
            prev + pw * ph <= tree.len() && offset + lw * z1 <= tree.len(),
            "height tree parent bounds"
        );
        for row in z0..z1 {
            for col in x0..x1 {
                let mut high = -1e6f32;
                for dz in 0..2 {
                    for dx in 0..2 {
                        if col * 2 + dx < pw && row * 2 + dz < ph {
                            high = high.max(f32::from_bits(
                                tree[prev + (row * 2 + dz) * pw + col * 2 + dx],
                            ));
                        }
                    }
                }
                tree[offset + row * lw + col] = high.to_bits();
            }
            ranges.push((offset + row * lw + x0, x1 - x0));
        }
    }
    Ok(ranges)
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct MaterialSpec {
    pub name: String,
    pub states: BTreeMap<String, Value>,
}

impl MaterialSpec {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.name.len() <= 128
                && self.name.contains(':')
                && self
                    .name
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"_:.-".contains(&c)),
            "invalid material name"
        );
        ensure!(self.states.len() <= 32, "too many block states");
        for (key, value) in &self.states {
            ensure!(key.len() <= 96 && !key.is_empty(), "invalid state key");
            ensure!(
                match value {
                    Value::Bool(_) => true,
                    Value::Number(n) => n.as_i64().is_some_and(|n| i32::try_from(n).is_ok()),
                    Value::String(s) => s.len() <= 128,
                    _ => false,
                },
                "invalid block state"
            );
        }
        Ok(())
    }

    pub fn key(&self) -> String {
        let canonical = self.canonicalized();
        // BDS booleans and saved NBT bytes describe the same permutation.
        let states: BTreeMap<_, _> = canonical
            .states
            .iter()
            .map(|(k, v)| {
                (
                    k,
                    match v {
                        Value::Bool(v) => Value::from(i32::from(*v)),
                        _ => v.clone(),
                    },
                )
            })
            .collect();
        serde_json::to_string(&(&self.name, states)).expect("JSON values")
    }

    fn canonicalized(&self) -> Self {
        static RULES: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
        let rules = RULES.get_or_init(|| {
            serde_json::from_str(include_str!("../../../terrain/rules.json"))
                .expect("checked-in terrain rules")
        });
        let mut result = self.clone();
        if let Some(defaults) = rules["canonical_state_defaults"][&self.name].as_object() {
            for (key, value) in defaults {
                if result.states.get(key) == Some(value) {
                    result.states.remove(key);
                }
            }
        }
        result
    }

    pub fn from_saved_key(key: &str) -> Result<Self> {
        let (name, states): (String, BTreeMap<String, Value>) = serde_json::from_str(key)?;
        let states = states
            .into_iter()
            .map(|(k, v)| {
                let v = match &v {
                    Value::Object(o) if o.len() == 1 => o.values().next().unwrap().clone(),
                    _ => v,
                };
                (k, v)
            })
            .collect();
        let result = Self { name, states };
        result.validate()?;
        Ok(result.canonicalized())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SurfaceChunk {
    pub cx: i32,
    pub cz: i32,
    pub columns: Vec<Column>,
}

impl SurfaceChunk {
    pub fn validate(&self, materials: usize, complete: bool) -> Result<()> {
        ensure!(
            (-524288..524288).contains(&self.cx) && (-524288..524288).contains(&self.cz),
            "chunk coordinate limit"
        );
        ensure!(self.columns.len() == CHUNK_CELLS, "incomplete chunk");
        for c in &self.columns {
            ensure!(
                (0..=2).contains(&c[0]) && (!complete || c[0] != 0),
                "unavailable column"
            );
            for i in [1, 6, 9] {
                ensure!(i16::try_from(c[i]).is_ok(), "invalid height");
            }
            for i in [2, 5, 8] {
                ensure!(
                    c[i] >= 0 && (c[i] as usize) < materials,
                    "invalid material ID"
                );
            }
            ensure!(
                (0..=0xffffff).contains(&c[3]) && c[4] >= -1 && (0..=384).contains(&c[7]),
                "invalid column attributes"
            );
            if c[0] != 1 {
                ensure!(
                    c[1] == -32768 && c[2] == 0 && c[5] == 0 && c[7] == 0 && c[8] == 0,
                    "empty column has surface data"
                );
            } else {
                ensure!(
                    (-1024..=5120).contains(&c[1]) && c[2] > 0,
                    "invalid Overworld surface"
                );
            }
        }
        Ok(())
    }

    pub fn from_region(r: &SurfaceRegion, cx: i32, cz: i32) -> Result<Self> {
        ensure!(
            cx.div_euclid(16) == r.rx && cz.div_euclid(16) == r.rz,
            "chunk outside region"
        );
        let mut columns = Vec::with_capacity(256);
        for z in 0..16 {
            for x in 0..16 {
                let i = (cz.rem_euclid(16) as usize * 16 + z) * 256
                    + cx.rem_euclid(16) as usize * 16
                    + x;
                columns.push([
                    r.coverage[i] as i32,
                    r.heights[i] as i32,
                    r.materials[i] as i32,
                    r.tints[i] as i32,
                    r.biomes[i] as i32,
                    r.overlays[i] as i32,
                    r.overlay_heights[i] as i32,
                    r.water_depth[i] as i32,
                    r.supports[i] as i32,
                    r.support_heights[i] as i32,
                ]);
            }
        }
        Ok(Self { cx, cz, columns })
    }

    pub fn apply(&self, r: &mut SurfaceRegion) -> Result<()> {
        ensure!(
            self.columns.len() == 256
                && self.cx.div_euclid(16) == r.rx
                && self.cz.div_euclid(16) == r.rz,
            "chunk outside region"
        );
        for (j, c) in self.columns.iter().enumerate() {
            let i = (self.cz.rem_euclid(16) as usize * 16 + j / 16) * 256
                + self.cx.rem_euclid(16) as usize * 16
                + j % 16;
            r.coverage[i] = c[0] as u32;
            r.heights[i] = c[1] as i16;
            r.materials[i] = c[2] as u32;
            r.tints[i] = c[3] as u32;
            r.biomes[i] = c[4] as u32;
            r.overlays[i] = c[5] as u32;
            r.overlay_heights[i] = c[6] as i16;
            r.water_depth[i] = c[7] as u32;
            r.supports[i] = c[8] as u32;
            r.support_heights[i] = c[9] as i16;
        }
        Ok(())
    }

    pub fn encode(&self) -> Result<Vec<u8>> {
        ensure!(self.columns.len() == 256, "incomplete chunk");
        let mut out = b"BSC1".to_vec();
        write_u32(&mut out, self.cx as u32);
        write_u32(&mut out, self.cz as u32);
        for i in 0..10 {
            let channel = self
                .columns
                .iter()
                .map(|c| (c[i] as i64 + i32::MAX as i64 + 1) as u32)
                .collect::<Vec<_>>();
            encode_channel(&channel, &mut out)?;
        }
        Ok(out)
    }

    pub fn decode(mut input: &[u8]) -> Result<Self> {
        ensure!(
            input.len() < 32 * 1024 && input.starts_with(b"BSC1"),
            "invalid chunk header"
        );
        input = &input[4..];
        let cx = read_u32(&mut input)? as i32;
        let cz = read_u32(&mut input)? as i32;
        let mut columns = vec![UNKNOWN; 256];
        for i in 0..10 {
            for (c, v) in columns.iter_mut().zip(decode_channel(&mut input, 256)?) {
                c[i] = (v as i64 - i32::MAX as i64 - 1) as i32;
            }
        }
        ensure!(input.is_empty(), "trailing chunk data");
        let result = Self { cx, cz, columns };
        result.validate(65536, false)?;
        Ok(result)
    }

    pub fn remap(&mut self, ids: &[u32]) -> Result<()> {
        for c in &mut self.columns {
            for i in [2, 5, 8] {
                c[i] = *ids
                    .get(c[i] as usize)
                    .ok_or_else(|| anyhow::anyhow!("invalid local material"))?
                    as i32;
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TerrainObservation {
    pub schema_version: u32,
    pub rules_version: u32,
    pub world_id: String,
    pub generation: String,
    pub producer: String,
    pub started_ms: u64,
    pub sequence: u64,
    pub scan_start_ms: u64,
    pub scan_end_ms: u64,
    pub materials: Vec<MaterialSpec>,
    pub chunks: Vec<SurfaceChunk>,
    #[serde(default)]
    pub diagnostics: ScanDiagnostics,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScanDiagnostics {
    pub queued: u32,
    pub pending_bytes: u32,
    pub oldest_scan_ms: u64,
    pub reads: u64,
    pub errors: u64,
    pub overflow: u64,
}

pub fn valid_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 80
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}

impl TerrainObservation {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.schema_version == 1 && self.rules_version == RULES_VERSION,
            "unsupported terrain protocol"
        );
        ensure!(
            [&self.world_id, &self.generation, &self.producer]
                .iter()
                .all(|s| valid_id(s)),
            "invalid identity"
        );
        ensure!(
            self.sequence > 0
                && self.sequence < i64::MAX as u64
                && self.started_ms <= self.scan_start_ms
                && self.scan_start_ms <= self.scan_end_ms,
            "invalid scan sequence"
        );
        ensure!(
            self.materials.len() <= 3073 && !self.materials.is_empty() && self.chunks.len() <= 4,
            "observation limits"
        );
        for m in &self.materials {
            m.validate()?;
        }
        ensure!(
            self.materials[0].name == "surface:unknown",
            "missing sentinel material"
        );
        let mut seen = std::collections::BTreeSet::new();
        for c in &self.chunks {
            c.validate(self.materials.len(), true)?;
            ensure!(seen.insert((c.cx, c.cz)), "duplicate chunk");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::MISSING_HEIGHT;
    #[test]
    fn rectangular_height_patches_match_full_rebuild() {
        let mut source = vec![0.; 512 * 257];
        let mut tree = crate::height_pyramid(&source, 512, 257);
        for (x, z, w, h, y) in [
            (250, 250, 16, 7, 20.),
            (256, 0, 256, 256, -4.),
            (0, 256, 512, 1, 100.),
            (250, 250, 16, 7, -1e6),
        ] {
            let values = vec![y; w * h];
            patch_height_tree(&mut tree, x, z, w, h, &values).unwrap();
            for row in 0..h {
                source[(z + row) * 512 + x..(z + row) * 512 + x + w]
                    .copy_from_slice(&values[row * w..(row + 1) * w]);
            }
            assert_eq!(tree, crate::height_pyramid(&source, 512, 257));
        }
        assert!(patch_height_tree(&mut tree, 512, 0, 1, 1, &[0.]).is_err());
    }
    #[test]
    fn exact_chunk_roundtrip_and_region_patch() {
        let mut c = SurfaceChunk {
            cx: -1,
            cz: -17,
            columns: vec![EMPTY; 256],
        };
        for (i, v) in c.columns.iter_mut().enumerate().take(200) {
            *v = [
                1,
                i as i32 - 100,
                1 + i as i32 % 13,
                0xabcdef,
                4,
                0,
                MISSING_HEIGHT as i32,
                0,
                1,
                0,
            ];
        }
        assert_eq!(SurfaceChunk::decode(&c.encode().unwrap()).unwrap(), c);
        let mut region = SurfaceRegion::empty(-1, -2);
        c.apply(&mut region).unwrap();
        assert_eq!(SurfaceChunk::from_region(&region, -1, -17).unwrap(), c);
        assert_eq!(region.coverage[0], 0);
        assert!(crate::decode_region(&crate::encode_live_region(&region).unwrap()).is_ok());
        assert!(crate::decode_region(&crate::encode_region(&region).unwrap()).is_err());
    }
    #[test]
    fn reject_corruption_missing_and_invalid_fields() {
        let c = SurfaceChunk {
            cx: 0,
            cz: 0,
            columns: vec![UNKNOWN; 256],
        };
        assert!(c.validate(1, true).is_err());
        let raw = c.encode().unwrap();
        assert!(SurfaceChunk::decode(&raw[..raw.len() - 1]).is_err());
        let mut trailing = raw.clone();
        trailing.push(0);
        assert!(SurfaceChunk::decode(&trailing).is_err());
        let mut bad = c.clone();
        bad.columns[0][0] = 3;
        assert!(SurfaceChunk::decode(&bad.encode().unwrap()).is_err());
        assert!(
            SurfaceChunk {
                columns: vec![],
                ..c
            }
            .encode()
            .is_err()
        );
    }
    #[test]
    fn stable_state_identity() {
        let old = MaterialSpec::from_saved_key(
            r#"["minecraft:oak_log",{"pillar_axis":{"String":"y"},"test":{"Byte":1}}]"#,
        )
        .unwrap();
        let new = MaterialSpec {
            name: "minecraft:oak_log".into(),
            states: BTreeMap::from([
                ("test".into(), Value::Bool(true)),
                ("pillar_axis".into(), Value::String("y".into())),
            ]),
        };
        assert_eq!(old.key(), new.key());
    }
}
