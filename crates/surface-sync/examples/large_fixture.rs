//! Dense synthetic worlds for bounded-window browser verification, never real data.
use anyhow::Result;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{fs, path::Path};
use surface_core::{CELLS, SurfaceRegion, encode_live_region};

fn object(output: &Path, bytes: &[u8], extension: &str) -> Result<Value> {
    let sha = format!("{:x}", Sha256::digest(bytes));
    let url = format!("objects/{sha}.{extension}");
    fs::write(output.join(&url), bytes)?;
    Ok(json!({"url":url,"sha256":sha,"bytes":bytes.len()}))
}

fn main() -> Result<()> {
    let input = Path::new(".local/terrain-fixture");
    let output = Path::new(".local/terrain-large");
    fs::create_dir_all(output.join("objects"))?;
    let template: Value = serde_json::from_slice(&fs::read(input.join("root-0.json"))?)?;
    for entry in fs::read_dir(input.join("state/objects"))? {
        let entry = entry?;
        fs::copy(entry.path(), output.join("objects").join(entry.file_name()))?;
    }
    let mut heights = Vec::with_capacity(CELLS * 2);
    for _ in 0..CELLS {
        heights.extend_from_slice(&1024i16.to_le_bytes());
    }
    let height_ref = object(output, &zstd::encode_all(heights.as_slice(), 3)?, "zst")?;
    let mut relief_heights = Vec::with_capacity(CELLS * 2);
    for i in 0..CELLS {
        let height = if i % 256 < 128 { -1024i16 } else { 5104i16 };
        relief_heights.extend_from_slice(&height.to_le_bytes());
    }
    let relief_ref = object(
        output,
        &zstd::encode_all(relief_heights.as_slice(), 3)?,
        "zst",
    )?;
    for (name, half, relief) in [("4", 8, false), ("16", 16, false), ("relief", 16, true)] {
        let mut root = template.clone();
        let mut regions = Vec::new();
        for rz in -half..half {
            for rx in -half..half {
                let mut region = SurfaceRegion::empty(rx, rz);
                region.coverage.fill(1);
                region.heights.fill(1024);
                region.materials.fill(1);
                region.supports.fill(1);
                region.support_heights.fill(1024);
                if relief {
                    for i in 0..CELLS {
                        let height = if i % 256 < 128 { -1024 } else { 5104 };
                        region.heights[i] = height;
                        region.support_heights[i] = height;
                    }
                }
                let surface = object(
                    output,
                    &zstd::encode_all(encode_live_region(&region)?.as_slice(), 3)?,
                    "zst",
                )?;
                let index = object(
                    output,
                    &serde_json::to_vec(&json!({"rx":rx,"rz":rz,"chunks":{}}))?,
                    "json",
                )?;
                regions.push(json!({"rx":rx,"rz":rz,"columns":CELLS,
                    "surface":surface,"heights":if relief {&relief_ref} else {&height_ref},"index":index}));
            }
        }
        root["bounds"] = json!([-half * 256, -half * 256, half * 256, half * 256]);
        root["spawn"] = json!([0, 64, 0]);
        root["height_range"] = if relief {
            json!([-1024, 5104])
        } else {
            json!([1024, 1024])
        };
        root["regions"] = json!(regions);
        fs::write(
            output.join(format!("root-{name}.json")),
            serde_json::to_vec(&root)?,
        )?;
    }
    println!(
        "Dense synthetic 4x/16x and high-relief fixtures written to {}",
        output.display()
    );
    Ok(())
}
