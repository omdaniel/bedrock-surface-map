use anyhow::{Context, Result, ensure};
use bedrock_world::nbt::NbtTag;
use bedrock_world::{
    BedrockWorld, BlockPos, BlockState, ChunkLoadOptions, Dimension, ExactSurfaceBiomeLoad,
    ExactSurfaceSubchunkPolicy, OpenOptions, ParsedBiomeStorage, SubChunk, SubChunkDecodeMode,
    TerrainColumnBiome, TerrainColumnOverlay, TerrainColumnSample, TerrainSurfaceRole,
    WorldScanOptions, WorldThreadingOptions, terrain_surface_role,
};
use std::{collections::BTreeMap, path::Path};
use surface_core::{Material, SurfaceRegion};

pub struct Extraction {
    pub regions: BTreeMap<(i32, i32), SurfaceRegion>,
    pub materials: Vec<Material>,
    pub spawn: [i32; 3],
    pub chunks: usize,
    pub verified_samples: usize,
}

fn value(state: &BlockState, key: &str) -> String {
    match state.states.get(key) {
        Some(NbtTag::String(s)) => s.clone(),
        Some(NbtTag::Byte(v)) => v.to_string(),
        Some(NbtTag::Int(v)) => v.to_string(),
        _ => String::new(),
    }
}

pub fn top_height(state: &BlockState, y: i16) -> Result<i16> {
    let mut fraction = 16i32;
    if state.name.contains("slab")
        && !state.name.contains("double")
        && value(state, "top_slot_bit") != "1"
        && value(state, "minecraft:vertical_half") != "top"
    {
        fraction = 8;
    }
    if state.name.ends_with(":snow_layer") {
        fraction = 2 * (value(state, "height").parse::<i32>().unwrap_or(0) + 1).clamp(1, 8);
    }
    if state.name.ends_with(":leaf_litter") {
        fraction = 1;
    }
    i16::try_from(y as i32 * 16 + fraction).context("surface height outside encoding range")
}

fn interner(
    state: &BlockState,
    ids: &mut BTreeMap<String, u32>,
    materials: &mut Vec<Material>,
) -> Result<u32> {
    let key = serde_json::to_string(&(&state.name, &state.states))?;
    if let Some(id) = ids.get(&key) {
        return Ok(*id);
    }
    let mut name = state.name.trim_start_matches("minecraft:").to_string();
    for (old, prop, suffix) in [
        ("stone", "stone_type", ""),
        ("dirt", "dirt_type", ""),
        ("sand", "sand_type", ""),
        ("leaves", "old_leaf_type", "_leaves"),
        ("leaves2", "new_leaf_type", "_leaves"),
        ("log", "old_log_type", "_log"),
        ("log2", "new_log_type", "_log"),
        ("planks", "wood_type", "_planks"),
    ] {
        if name == old {
            let v = value(state, prop);
            if !v.is_empty() {
                name = format!("{v}{suffix}");
            }
        }
    }
    let tint = if name.contains("water") {
        3
    } else if name.contains("leaves") {
        2
    } else if matches!(
        name.as_str(),
        "grass"
            | "grass_block"
            | "short_grass"
            | "tallgrass"
            | "tall_grass"
            | "fern"
            | "large_fern"
            | "vine"
    ) {
        1
    } else {
        0
    };
    let id = materials.len() as u32;
    ensure!(id < 65536, "material catalog too large");
    materials.push(Material {
        key: key.clone(),
        name: name.clone(),
        texture: name.clone(),
        tint,
        approximate: name.contains("stairs")
            || name.contains("fence")
            || name.contains("glass")
            || name == "leaf_litter",
        uv: [0.; 4],
        average: [0.; 4],
    });
    ids.insert(key, id);
    Ok(id)
}

fn retain_leaf_litter(sample: &mut TerrainColumnSample, below: BlockState) -> Result<()> {
    ensure!(
        terrain_surface_role(&below.name) == TerrainSurfaceRole::Primary
            && below.name != "minecraft:leaf_litter",
        "leaf litter is not supported by a solid surface"
    );
    sample.overlay.get_or_insert(TerrainColumnOverlay {
        y: sample.surface_y,
        block_state: sample.surface_block_state.clone(),
        source: sample.source,
    });
    sample.surface_y = sample
        .surface_y
        .checked_sub(1)
        .context("leaf litter height underflow")?;
    sample.surface_block_state = below.clone();
    sample.relief_y = sample.surface_y;
    sample.relief_block_state = below;
    Ok(())
}

// Bounded vanilla-biome palette, not a claim of exact Minecraft climate blending.
fn biome_tint(biome: u32) -> u32 {
    static RULES: std::sync::OnceLock<serde_json::Value> = std::sync::OnceLock::new();
    let rules = RULES.get_or_init(|| {
        serde_json::from_str(include_str!("../../../terrain/rules.json"))
            .expect("checked surface rules")
    });
    rules["tints"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| {
            t["ids"]
                .as_array()
                .unwrap()
                .iter()
                .any(|v| v.as_u64() == Some(biome as u64))
        })
        .map_or(&rules["default_tint"], |t| &t["rgb"])
        .as_u64()
        .unwrap() as u32
}

fn surface_biome(
    storages: &BTreeMap<i32, ParsedBiomeStorage>,
    sample: &TerrainColumnSample,
    x: u8,
    z: u8,
) -> u32 {
    let y = i32::from(
        sample
            .water
            .as_ref()
            .and_then(|w| w.underwater_y)
            .unwrap_or(sample.relief_y),
    );
    let storage = storages
        .get(&(y.div_euclid(16) * 16))
        .or_else(|| storages.values().find(|s| s.y.is_none()));
    // bedrock-world 0.3.5's surface helper filters ID 0, which is valid ocean.
    // Read the already-decoded storage at the support height without that filter.
    if let Some(s) = storage {
        let local_y = s.y.map_or(0, |base| (y - base) as u8);
        if let Some(id) = s.biome_id_at(x, local_y, z) {
            return id;
        }
        if s.indices.is_none() && s.palette.len() == 1 {
            return s.palette[0];
        }
        return u32::MAX;
    }
    match sample.biome {
        Some(TerrainColumnBiome::Legacy(value)) => u32::from(value.biome_id),
        _ => u32::MAX,
    }
}

pub fn extract(path: &Path) -> Result<Extraction> {
    let mut regions = BTreeMap::new();
    let mut result = extract_stream(path, |r| {
        regions.insert((r.rx, r.rz), r);
        Ok(())
    })?;
    result.regions = regions;
    Ok(result)
}

/// Emit completed regions, retaining only one region plus a bounded chunk batch.
pub fn extract_stream(
    path: &Path,
    consume: impl FnMut(SurfaceRegion) -> Result<()>,
) -> Result<Extraction> {
    extract_selected(path, None, consume)
}

pub fn extract_chunk(path: &Path, x: i32, z: i32) -> Result<Extraction> {
    let mut regions = BTreeMap::new();
    let mut result = extract_selected(path, Some([x, z]), |r| {
        regions.insert((r.rx, r.rz), r);
        Ok(())
    })?;
    result.regions = regions;
    Ok(result)
}

fn extract_selected(
    path: &Path,
    selection: Option<[i32; 2]>,
    mut consume: impl FnMut(SurfaceRegion) -> Result<()>,
) -> Result<Extraction> {
    let document = bedrock_world::read_level_dat(&path.join("level.dat"))?;
    ensure!(
        document.warnings.is_empty(),
        "level.dat has format warnings"
    );
    let root = match document.root {
        NbtTag::Compound(v) => v,
        _ => anyhow::bail!("level.dat root is not compound"),
    };
    let spawn = ["SpawnX", "SpawnY", "SpawnZ"].map(|k| match root.get(k) {
        Some(NbtTag::Int(v)) => *v,
        _ => 0,
    });
    let world = BedrockWorld::open_blocking(
        path,
        OpenOptions {
            read_only: true,
            ..Default::default()
        },
    )?;
    let mut positions = world.list_render_chunk_positions_blocking(WorldScanOptions {
        threading: WorldThreadingOptions::Fixed(2),
        ..Default::default()
    })?;
    positions.retain(|p| p.dimension == Dimension::Overworld);
    if let Some([x, z]) = selection {
        positions.retain(|p| p.x == x && p.z == z);
    }
    ensure!(
        positions
            .iter()
            .all(|p| (-524288..524288).contains(&p.x) && (-524288..524288).contains(&p.z)),
        "chunk outside exact GPU coordinate range"
    );
    positions.sort_by_key(|p| (p.z.div_euclid(16), p.x.div_euclid(16), p.z, p.x));
    ensure!(!positions.is_empty(), "no Overworld chunks found");
    ensure!(
        positions.len() <= 1048576,
        "snapshot exceeds bounded import chunk limit"
    );
    let mut current: Option<SurfaceRegion> = None;
    let mut ids = BTreeMap::new();
    let mut materials = vec![Material {
        key: "unknown".into(),
        name: "Unknown".into(),
        texture: "unknown".into(),
        tint: 0,
        approximate: true,
        uv: [0.; 4],
        average: [1., 0., 1., 1.],
    }];
    let mut verified_samples = 0;
    for (batch_number, batch) in positions.chunks(32).enumerate() {
        let mut options = ChunkLoadOptions::exact_surface_columns(
            ExactSurfaceSubchunkPolicy::Full,
            ExactSurfaceBiomeLoad::TopColumns,
            false,
        );
        options.threading = WorldThreadingOptions::Fixed(2);
        let (mut chunks, stats) =
            world.query_chunk_data_with_stats_blocking(batch.iter().copied(), options)?;
        ensure!(
            stats.missing_subchunk_columns == 0,
            "missing subchunk columns in batch {batch_number}"
        );
        chunks.sort_by_key(|c| {
            (
                c.pos.z.div_euclid(16),
                c.pos.x.div_euclid(16),
                c.pos.z,
                c.pos.x,
            )
        });
        for chunk in chunks {
            ensure!(chunk.is_loaded, "chunk {:?} could not be loaded", chunk.pos);
            let rx = chunk.pos.x.div_euclid(16);
            let rz = chunk.pos.z.div_euclid(16);
            if current.as_ref().is_some_and(|r| r.rx != rx || r.rz != rz) {
                consume(current.take().unwrap())?;
            }
            let region = current.get_or_insert_with(|| SurfaceRegion::empty(rx, rz));
            let samples = chunk.column_samples.context("surface samples missing")?;
            // Released 0.3.5 treats leaf litter as solid. Decode each needed layer
            // once per chunk to retain the real supporting block under this overlay.
            let mut layers = BTreeMap::<i16, SubChunk>::new();
            for z in 0..16u8 {
                for x in 0..16u8 {
                    let Some(c) = samples.get(x, z) else {
                        continue;
                    };
                    let mut adjusted;
                    let c = if c.surface_block_state.name == "minecraft:leaf_litter" {
                        let y = c
                            .surface_y
                            .checked_sub(1)
                            .context("leaf litter height underflow")?;
                        let sy = y.div_euclid(16);
                        if let std::collections::btree_map::Entry::Vacant(entry) = layers.entry(sy)
                        {
                            entry.insert(
                                world
                                    .get_subchunk_layer_blocking(
                                        chunk.pos,
                                        y as i32,
                                        SubChunkDecodeMode::FullIndices,
                                    )?
                                    .context("leaf litter support subchunk missing")?,
                            );
                        }
                        let below = layers[&sy]
                            .block_state_at(x, y.rem_euclid(16) as u8, z)
                            .context("leaf litter supporting block missing")?
                            .clone();
                        adjusted = c.clone();
                        retain_leaf_litter(&mut adjusted, below)?;
                        &adjusted
                    } else {
                        c
                    };
                    let ix = chunk.pos.x.rem_euclid(16) as usize * 16 + x as usize;
                    let iz = chunk.pos.z.rem_euclid(16) as usize * 16 + z as usize;
                    let i = iz * 256 + ix;
                    region.coverage[i] = 1;
                    region.heights[i] = top_height(&c.surface_block_state, c.surface_y)?;
                    region.materials[i] =
                        interner(&c.surface_block_state, &mut ids, &mut materials)?;
                    let biome = surface_biome(&chunk.biome_data, c, x, z);
                    region.biomes[i] = biome;
                    region.tints[i] = biome_tint(biome);
                    region.supports[i] = interner(&c.relief_block_state, &mut ids, &mut materials)?;
                    region.support_heights[i] = top_height(&c.relief_block_state, c.relief_y)?;
                    if let Some(overlay) = &c.overlay {
                        region.overlays[i] =
                            interner(&overlay.block_state, &mut ids, &mut materials)?;
                        region.overlay_heights[i] = top_height(&overlay.block_state, overlay.y)?;
                    }
                    if let Some(w) = &c.water {
                        region.water_depth[i] = w.depth as u32;
                        if let (Some(s), Some(y)) = (&w.underwater_block_state, w.underwater_y) {
                            region.supports[i] = interner(s, &mut ids, &mut materials)?;
                            region.support_heights[i] = top_height(s, y)?;
                        }
                    }
                    if batch_number % 16 == 0 && x == 8 && z == 8 {
                        let pos = BlockPos {
                            x: chunk.pos.x * 16 + x as i32,
                            y: c.surface_y as i32,
                            z: chunk.pos.z * 16 + z as i32,
                        };
                        let raw = world
                            .get_block_state_at_blocking(Dimension::Overworld, pos)?
                            .context("sample validation missing raw block")?;
                        ensure!(
                            raw == c.surface_block_state,
                            "surface validation mismatch at {pos:?}"
                        );
                        verified_samples += 1;
                    }
                }
            }
        }
        if batch_number % 16 == 0 {
            eprintln!(
                "Extracted {}/{} chunks",
                ((batch_number + 1) * 32).min(positions.len()),
                positions.len()
            );
        }
    }
    if let Some(region) = current {
        consume(region)?;
    }
    Ok(Extraction {
        regions: BTreeMap::new(),
        materials,
        spawn,
        chunks: positions.len(),
        verified_samples,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn negative_and_partial_heights() {
        let state = BlockState {
            name: "minecraft:oak_slab".into(),
            states: BTreeMap::new(),
            version: None,
        };
        assert_eq!(top_height(&state, -1).unwrap(), -8);
        assert_eq!((-1i32).div_euclid(16), -1);
        assert_eq!((-1i32).rem_euclid(16), 15);
    }

    #[test]
    fn leaf_litter_retains_support_and_thin_overlay() {
        let litter = BlockState {
            name: "minecraft:leaf_litter".into(),
            states: BTreeMap::new(),
            version: None,
        };
        let below = BlockState {
            name: "minecraft:grass_block".into(),
            ..litter.clone()
        };
        let mut sample = TerrainColumnSample {
            surface_y: -16,
            surface_block_state: litter.clone(),
            relief_y: -16,
            relief_block_state: litter.clone(),
            overlay: None,
            water: None,
            biome: None,
            source: bedrock_world::TerrainSampleSource::Subchunk,
        };
        retain_leaf_litter(&mut sample, below.clone()).unwrap();
        assert_eq!(sample.surface_y, -17);
        assert_eq!(sample.surface_block_state, below);
        assert_eq!(sample.overlay.as_ref().unwrap().block_state, litter);
        assert_eq!(top_height(&litter, -16).unwrap(), -255);
        assert!(retain_leaf_litter(&mut sample, litter).is_err());
    }

    #[test]
    fn ocean_zero_is_valid_and_support_height_selects_the_biome_layer() {
        let block = BlockState {
            name: "minecraft:stone".into(),
            states: BTreeMap::new(),
            version: None,
        };
        let sample = TerrainColumnSample {
            surface_y: 200,
            surface_block_state: block.clone(),
            relief_y: 200,
            relief_block_state: block,
            overlay: None,
            water: None,
            biome: Some(TerrainColumnBiome::Id(1)),
            source: bedrock_world::TerrainSampleSource::Subchunk,
        };
        let storage = ParsedBiomeStorage {
            y: Some(192),
            palette: vec![0],
            indices: Some(vec![0; 4096]),
            counts: vec![4096],
        };
        assert_eq!(
            surface_biome(&BTreeMap::from([(192, storage)]), &sample, 12, 0),
            0
        );
        assert_eq!(surface_biome(&BTreeMap::new(), &sample, 12, 0), u32::MAX);
    }
}
