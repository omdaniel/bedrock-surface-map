use surface_core::lod::{DetailTile, HeightTile, SummaryTile, TileKey, decompress_lod};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn decode_lod_words(
    bytes: &[u8],
    kind: &str,
    level: u8,
    x: i32,
    z: i32,
    material_count: u32,
) -> Result<Vec<u32>, JsValue> {
    let decode = || -> anyhow::Result<Vec<u32>> {
        let key = TileKey::new(level, x, z)?;
        anyhow::ensure!((1..=65536).contains(&material_count), "LOD material count");
        let raw = decompress_lod(bytes)?;
        match kind {
            "detail" => {
                let tile = DetailTile::decode(&raw)?;
                anyhow::ensure!(tile.key == key, "LOD tile coordinates mismatch");
                for column in &tile.columns {
                    for field in [2, 5, 8] {
                        anyhow::ensure!(
                            column[field] >= 0 && (column[field] as u32) < material_count,
                            "LOD material reference out of range"
                        );
                    }
                }
                Ok(tile.gpu_words())
            }
            "summary" => {
                let tile = SummaryTile::decode(&raw)?;
                anyhow::ensure!(
                    tile.key == key && level > 0,
                    "LOD summary coordinates mismatch"
                );
                Ok(tile.gpu_words())
            }
            "height" => {
                let tile = HeightTile::decode(&raw)?;
                anyhow::ensure!(tile.key == key, "LOD height coordinates mismatch");
                Ok(tile.gpu_words())
            }
            _ => anyhow::bail!("Unsupported LOD decode kind"),
        }
    };
    decode().map_err(|error| JsValue::from_str(&error.to_string()))
}
