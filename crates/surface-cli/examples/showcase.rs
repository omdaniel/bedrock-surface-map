//! Export an approved surface-only excerpt. Never reads textures or a live world.
use anyhow::{Result, ensure};
use image::{Rgba, RgbaImage};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs, io::Cursor, path::Path};
use surface_core::{terrain::SurfaceChunk, *};

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn object(out: &Path, bytes: &[u8], extension: &str) -> Result<Value> {
    let sha = hash(bytes);
    let url = format!("objects/{sha}.{extension}");
    fs::write(out.join(&url), bytes)?;
    Ok(json!({"url":url,"sha256":sha,"bytes":bytes.len()}))
}
fn packed(out: &Path, bytes: &[u8]) -> Result<Value> {
    object(out, &zstd::encode_all(bytes, 3)?, "zst")
}
fn atlas(out: &Path, materials: &mut [Material]) -> Result<Value> {
    let size = materials.len().div_ceil(16) as u32 * 20;
    let mut image = RgbaImage::new(320, size);
    for (i, m) in materials.iter_mut().enumerate() {
        let n = m.name.to_lowercase();
        let tinted = m.tint == 1 || m.tint == 2;
        let base: [u8; 3] = if i == 0 {
            [225, 20, 180]
        } else if tinted {
            [165, 175, 158]
        } else if n.contains("sand") {
            [214, 199, 144]
        } else if n.contains("snow") {
            [224, 234, 240]
        } else if n.contains("water") {
            [30, 110, 180]
        } else if n.contains("wood") || n.contains("log") || n.contains("plank") {
            [151, 113, 69]
        } else if n.contains("dirt") || n.contains("mud") {
            [133, 102, 73]
        } else if n.contains("flower") {
            [205, 140, 83]
        } else {
            [139, 149, 145]
        };
        let ox = i as u32 % 16 * 20;
        let oy = i as u32 / 16 * 20;
        let mut sum = [0f32; 3];
        for y in 0..20u32 {
            for x in 0..20u32 {
                let u = x.clamp(2, 17) - 2;
                let v = y.clamp(2, 17) - 2;
                let seed = u.wrapping_mul(374761393) ^ v.wrapping_mul(668265263) ^ (i as u32 * 97);
                let noise = ((seed ^ (seed >> 13)).wrapping_mul(1274126177) >> 25) as i32 % 23 - 11;
                let grain = if n.contains("plank") && v % 8 == 0 {
                    -22
                } else {
                    noise
                };
                let rgb = base.map(|c| (c as i32 + grain).clamp(0, 255) as u8);
                image.put_pixel(ox + x, oy + y, Rgba([rgb[0], rgb[1], rgb[2], 255]));
                if (2..18).contains(&x) && (2..18).contains(&y) {
                    for k in 0..3 {
                        sum[k] += rgb[k] as f32 / (255. * 256.);
                    }
                }
            }
        }
        m.uv = [
            (ox + 2) as f32 / 320.,
            (oy + 2) as f32 / size as f32,
            16. / 320.,
            16. / size as f32,
        ];
        m.average = [sum[0], sum[1], sum[2], 1.];
        m.texture = format!("original-demo-{}", m.name);
    }
    let mut png = Cursor::new(Vec::new());
    image.write_to(&mut png, image::ImageFormat::Png)?;
    object(out, &png.into_inner(), "png")
}
fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    ensure!(
        args.len() == 3,
        "showcase INPUT_SURFACE_DIRECTORY OUTPUT_DIRECTORY"
    );
    let input = Path::new(&args[1]);
    let out = Path::new(&args[2]);
    ensure!(!out.exists(), "output must be a new directory");
    fs::create_dir_all(out.join("objects"))?;
    let source: MapManifest = serde_json::from_slice(&fs::read(input.join("manifest.json"))?)?;
    let mut regions = Vec::new();
    for r in &source.regions {
        if !(-2..2).contains(&r.rx) || !(-2..2).contains(&r.rz) {
            continue;
        }
        let bytes = fs::read(input.join(&r.url))?;
        ensure!(hash(&bytes) == r.sha256, "source checksum");
        let decoded = decode_region(&decompress(&bytes, MAX_DECOMPRESSED)?)?;
        ensure!(
            (decoded.rx, decoded.rz) == (r.rx, r.rz),
            "source coordinate mismatch"
        );
        regions.push(decoded);
    }
    ensure!(regions.len() == 16, "excerpt needs 16 complete regions");
    let mut ids = BTreeMap::from([(0u32, 0u32)]);
    for r in &regions {
        for id in r.materials.iter().chain(&r.overlays).chain(&r.supports) {
            let next = ids.len() as u32;
            ids.entry(*id).or_insert(next);
        }
    }
    let mut materials = vec![source.materials[0].clone(); ids.len()];
    for (&old, &new) in &ids {
        materials[new as usize] = source.materials[old as usize].clone();
    }
    for r in &mut regions {
        for id in r
            .materials
            .iter_mut()
            .chain(&mut r.overlays)
            .chain(&mut r.supports)
        {
            *id = ids[id];
        }
    }
    let wood = materials.len() as u32;
    materials.push(Material {
        key: json!(["minecraft:oak_planks", {}]).to_string(),
        name: "oak_planks".into(),
        texture: String::new(),
        tint: 0,
        approximate: false,
        uv: [0.; 4],
        average: [0.; 4],
    });
    let atlas = atlas(out, &mut materials)?;
    let catalog = object(out, &serde_json::to_vec(&materials)?, "json")?;
    // A reproducible flat beach near the center keeps the demonstration visible.
    let region = regions.iter().find(|r| r.rx == -1 && r.rz == -1).unwrap();
    let mut site = None;
    for z in 96..244usize {
        for x in 96..244usize {
            let i = z * 256 + x;
            if materials[region.materials[i] as usize].name == "sand"
                && (0..8).all(|dz| {
                    (0..8).all(|dx| {
                        let j = (z + dz) * 256 + x + dx;
                        region.coverage[j] == 1
                            && region.water_depth[j] == 0
                            && region.heights[j] == region.heights[i]
                    })
                })
            {
                site = Some((x as i32 - 256, z as i32 - 256, region.heights[i]));
                break;
            }
        }
        if site.is_some() {
            break;
        }
    }
    let (sx, sz, sh) = site.ok_or_else(|| anyhow::anyhow!("no showcase beach"))?;
    let baseline = regions.clone();
    let fingerprint = hash(format!("coastal-showcase-v1:{}", source.source_sha256).as_bytes());
    for stage in 0..4 {
        regions.clone_from(&baseline);
        if stage == 1 || stage == 2 {
            let r = regions
                .iter_mut()
                .find(|r| r.rx == -1 && r.rz == -1)
                .unwrap();
            for z in 0..8 {
                for x in 0..8 {
                    if stage == 2 && x > 1 && x < 6 && z > 1 && z < 6 {
                        continue;
                    }
                    let i = (sz + 256 + z) as usize * 256 + (sx + 256 + x) as usize;
                    r.heights[i] = sh + 48;
                    r.materials[i] = wood;
                    r.tints[i] = 0xffffff;
                    r.overlays[i] = 0;
                    r.overlay_heights[i] = MISSING_HEIGHT;
                    r.supports[i] = wood;
                    r.support_heights[i] = sh + 48;
                }
            }
        }
        let mut refs = Vec::new();
        let mut range = [i16::MAX, i16::MIN];
        for r in &regions {
            let bytes = encode_region(r)?;
            ensure!(decode_region(&bytes)? == *r, "region round trip");
            let surface = packed(out, &bytes)?;
            let heights = packed(
                out,
                &r.heights
                    .iter()
                    .flat_map(|h| h.to_le_bytes())
                    .collect::<Vec<_>>(),
            )?;
            let mut chunks = BTreeMap::new();
            for z in 0..16 {
                for x in 0..16 {
                    let chunk = SurfaceChunk::from_region(r, r.rx * 16 + x, r.rz * 16 + z)?;
                    let encoded = chunk.encode()?;
                    ensure!(SurfaceChunk::decode(&encoded)? == chunk, "chunk round trip");
                    chunks.insert(format!("{},{}", chunk.cx, chunk.cz), packed(out, &encoded)?);
                }
            }
            let index = object(
                out,
                &serde_json::to_vec(&json!({"rx":r.rx,"rz":r.rz,"chunks":chunks}))?,
                "json",
            )?;
            for (&h, &present) in r.heights.iter().zip(&r.coverage) {
                if present == 1 {
                    range[0] = range[0].min(h);
                    range[1] = range[1].max(h);
                }
            }
            refs.push(json!({"rx":r.rx,"rz":r.rz,"surface":surface,"heights":heights,"index":index,"columns":r.coverage.iter().filter(|&&v|v==1).count()}));
        }
        let root = json!({"format_version":2,"rules_version":1,"world_id":"coastal-showcase","generation":"showcase-v1","revision":stage+1,"name":"Coastal Showcase","bounds":[-512,-512,512,512],"spawn":[sx+4,sh/16,sz+4],"source_sha256":fingerprint,"catalog":catalog,"atlas":atlas,"height_range":range,"regions":refs});
        fs::write(
            out.join(format!("stage-{stage}.json")),
            serde_json::to_vec(&root)?,
        )?;
    }
    let scenario = json!({"version":1,"duration_ms":60000,"world_id":"coastal-showcase","generation":"showcase-v1","stages":["stage-0.json","stage-1.json","stage-2.json","stage-3.json"],"site":[sx+4,sh as f64/16.,sz+4],"camera":[sx+4,sz+4,2.5],"names":["Rowan","Morgan"]});
    fs::write(
        out.join("scenario.json"),
        serde_json::to_vec_pretty(&scenario)?,
    )?;
    fs::write(
        out.join("NOTICE.txt"),
        "Coastal Showcase v1. Owner-approved derived surface excerpt; not a world backup. Original procedural demo texture artwork is dedicated under CC0 1.0 (https://creativecommons.org/publicdomain/zero/1.0/). This dedication does not cover terrain, Minecraft names or third-party rights. No Mojang texture pixels. Activity and player names are fictional. Not an official Minecraft product; not approved by or associated with Mojang or Microsoft.\n",
    )?;
    println!(
        "{}",
        json!({"site":[sx,sh/16,sz],"bounds":[-512,-512,512,512],"source_sha256":source.source_sha256,"public_fingerprint":fingerprint,"materials":materials.len()})
    );
    Ok(())
}
