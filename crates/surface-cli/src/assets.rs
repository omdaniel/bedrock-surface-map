use anyhow::{Context, Result, ensure};
use image::{Rgba, RgbaImage};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs,
    io::{Cursor, Read},
    path::Path,
};
use surface_core::Material;
const SOURCE: &str = "736072450c26a7c67f07b1661f29d9a5ebaa14b1";
const TILE: u32 = 32;
const CELL: u32 = 40;

fn json_entry(z: &mut zip::ZipArchive<fs::File>, path: &str) -> Result<Value> {
    let mut text = String::new();
    z.by_name(path)?.read_to_string(&mut text)?;
    Ok(json5::from_str(&text)?)
}
fn first_texture(v: &Value) -> Option<&str> {
    if let Some(s) = v.as_str() {
        return Some(s);
    }
    if let Some(a) = v.as_array() {
        return a.first().and_then(first_texture);
    }
    v.get("path").and_then(first_texture)
}

fn finish(output: &Path, materials: &mut [Material], images: &[RgbaImage]) -> Result<String> {
    let cols = 16u32;
    let rows = (images.len() as u32).div_ceil(cols);
    let mut atlas = RgbaImage::new(cols * CELL, rows * CELL);
    for (i, (m, img)) in materials.iter_mut().zip(images).enumerate() {
        let tile = image::imageops::resize(img, TILE, TILE, image::imageops::FilterType::Nearest);
        let ox = i as u32 % cols * CELL;
        let oy = i as u32 / cols * CELL;
        for y in 0..CELL {
            for x in 0..CELL {
                let sx = (x as i32 - 4).clamp(0, TILE as i32 - 1) as u32;
                let sy = (y as i32 - 4).clamp(0, TILE as i32 - 1) as u32;
                atlas.put_pixel(ox + x, oy + y, *tile.get_pixel(sx, sy));
            }
        }
        m.uv = [
            (ox + 4) as f32 / atlas.width() as f32,
            (oy + 4) as f32 / atlas.height() as f32,
            TILE as f32 / atlas.width() as f32,
            TILE as f32 / atlas.height() as f32,
        ];
        let mut sum = [0f32; 4];
        for p in tile.pixels() {
            let a = p[3] as f32 / 255.;
            for c in 0..3 {
                sum[c] += p[c] as f32 / 255. * a;
            }
            sum[3] += a;
        }
        let alpha = sum[3] / (TILE * TILE) as f32;
        m.average = [
            sum[0] / sum[3].max(1.),
            sum[1] / sum[3].max(1.),
            sum[2] / sum[3].max(1.),
            alpha,
        ];
    }
    let mut png = Cursor::new(Vec::new());
    atlas.write_to(&mut png, image::ImageFormat::Png)?;
    let bytes = png.into_inner();
    let name = format!("assets/{}.png", crate::hash(&bytes));
    crate::atomic_write(&output.join(&name), &bytes)?;
    Ok(name)
}
pub fn synthetic(output: &Path, materials: &mut [Material]) -> Result<String> {
    let images = materials
        .iter()
        .map(|m| RgbaImage::from_pixel(16, 16, Rgba(m.average.map(|v| (v * 255.) as u8))))
        .collect::<Vec<_>>();
    finish(output, materials, &images)
}

pub fn prepare(
    path: &Path,
    output: &Path,
    materials: &mut [Material],
) -> Result<(String, Vec<String>)> {
    let mut zip = zip::ZipArchive::new(
        fs::File::open(path)
            .context("run npm run assets to download the pinned Minecraft samples")?,
    )?;
    let prefix = format!("bedrock-samples-{SOURCE}/resource_pack/");
    let blocks = json_entry(&mut zip, &format!("{prefix}blocks.json"))?;
    let terrain = json_entry(&mut zip, &format!("{prefix}textures/terrain_texture.json"))?;
    let mut unknown = vec![];
    let mut images = vec![];
    let mut cache = BTreeMap::<String, RgbaImage>::new();
    for m in materials.iter_mut() {
        let alias = match m.name.as_str() {
            "grass_block" => "grass",
            "short_grass" => "tallgrass",
            "water" | "flowing_water" => "still_water_grey",
            "snow_layer" => "snow",
            _ => &m.name,
        };
        let block = &blocks[alias]["textures"];
        let key = block
            .as_str()
            .or_else(|| block["up"].as_str())
            .or_else(|| block["side"].as_str())
            .unwrap_or(alias);
        let entry = &terrain["texture_data"][key]["textures"];
        let texture = first_texture(entry).unwrap_or("");
        m.texture = texture.into();
        let mut result = None;
        if !texture.is_empty() {
            if let Some(img) = cache.get(texture) {
                result = Some(img.clone());
            } else {
                for ext in ["png", "tga"] {
                    let name = format!("{prefix}{texture}.{ext}");
                    if let Ok(mut e) = zip.by_name(&name) {
                        ensure!(e.size() < 32 * 1024 * 1024, "texture asset too large");
                        let mut bytes = vec![];
                        e.read_to_end(&mut bytes)?;
                        let format = if ext == "png" {
                            image::ImageFormat::Png
                        } else {
                            image::ImageFormat::Tga
                        };
                        let decoded =
                            image::load_from_memory_with_format(&bytes, format)?.to_rgba8();
                        let side = decoded.width().min(decoded.height());
                        let img = image::imageops::crop_imm(&decoded, 0, 0, side, side).to_image();
                        cache.insert(texture.into(), img.clone());
                        result = Some(img);
                        break;
                    }
                }
            }
        }
        if result.is_none() {
            if m.name != "Unknown" {
                unknown.push(m.name.clone());
            }
            let mut check = RgbaImage::new(16, 16);
            for (x, y, p) in check.enumerate_pixels_mut() {
                *p = if (x / 4 + y / 4) % 2 == 0 {
                    Rgba([240, 45, 175, 255])
                } else {
                    Rgba([70, 20, 65, 255])
                };
            }
            result = Some(check);
            m.approximate = true;
        }
        let mut img = result.unwrap();
        if m.name == "leaf_litter" {
            // Mojang's grayscale texture needs dry-foliage tint. Use a declared
            // fixed approximation until climate-specific dry-foliage colors exist.
            for p in img.pixels_mut() {
                for (c, tint) in [184u16, 133, 66].into_iter().enumerate() {
                    p[c] = (p[c] as u16 * tint / 255) as u8;
                }
            }
        }
        images.push(img);
    }
    unknown.sort();
    unknown.dedup();
    let name = finish(output, materials, &images)?;
    let mut license = String::new();
    zip.by_name(&format!("bedrock-samples-{SOURCE}/LICENSE.md"))?
        .read_to_string(&mut license)?;
    crate::atomic_write(&output.join("assets/MOJANG-LICENSE.md"), license.as_bytes())?;
    crate::atomic_write(&output.join("assets/NOTICE.txt"),format!("Minecraft assets (c) Mojang AB. All rights reserved. Subject to the Minecraft EULA.\nSource: https://github.com/Mojang/bedrock-samples/tree/{SOURCE}\nLocal generated atlas; not distributed in the application source repository.\n").as_bytes())?;
    Ok((name, unknown))
}
