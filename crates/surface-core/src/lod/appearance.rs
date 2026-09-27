use crate::{Material, terrain::Column};
use anyhow::{Context, Result, ensure};

pub fn validate_materials(materials: &[Material]) -> Result<()> {
    ensure!(
        !materials.is_empty() && materials.len() <= 65536,
        "catalog size limit"
    );
    for m in materials {
        ensure!(
            !m.key.is_empty()
                && m.key.encode_utf16().count() <= 4096
                && !m.name.is_empty()
                && m.name.encode_utf16().count() <= 1024
                && m.texture.encode_utf16().count() <= 1024,
            "invalid material text"
        );
        ensure!(
            m.tint <= 3
                && m.average
                    .iter()
                    .chain(&m.uv)
                    .all(|v| v.is_finite() && (0.0..=1.0).contains(v)),
            "invalid material appearance"
        );
        ensure!(
            m.uv[0] + m.uv[2] <= 1.000001 && m.uv[1] + m.uv[3] <= 1.000001,
            "material atlas bounds"
        );
    }
    Ok(())
}

fn color(m: &Material, tint: i32, vivid: bool) -> [f32; 4] {
    let mut c = m.average;
    if m.tint == 1 || m.tint == 2 {
        let rgb = [
            ((tint >> 16) & 255) as f32 / 255.,
            ((tint >> 8) & 255) as f32 / 255.,
            (tint & 255) as f32 / 255.,
        ];
        let luminance = (c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722).max(0.15);
        let base = if m.tint == 2 {
            [0.64, 0.82, 0.56]
        } else {
            [0.93; 3]
        };
        for i in 0..3 {
            c[i] = if vivid {
                (c[i] / luminance * base[i] * rgb[i]).clamp(0., 1.)
            } else {
                c[i] * rgb[i]
            };
        }
    }
    c
}

/// Unlit `overview.wgsl` appearance, including tint, support/water, overlays and
/// grade. Stored averages already use the renderer's numeric texture space;
/// applying an sRGB transfer here would change the existing appearance.
pub fn appearance_colors(column: &Column, materials: &[Material]) -> Result<[[f32; 3]; 2]> {
    let get = |i: usize| {
        materials
            .get(column[i] as usize)
            .context("material outside catalog")
    };
    let top = get(2)?;
    let mut result = [[0.; 3]; 2];
    for (mode, out) in result.iter_mut().enumerate() {
        let vivid = mode == 1;
        let mut c = color(top, column[3], vivid);
        if column[7] > 0 {
            let support = color(get(8)?, column[3], vivid);
            let water = if vivid {
                [0.055, 0.33, 0.72]
            } else {
                [0.08, 0.38, 0.64]
            };
            let opacity = 1. - (-(column[7] as f32) * 0.16).exp();
            for i in 0..3 {
                c[i] = (support[i] * (1. - opacity) + water[i] * opacity)
                    * (0.85 * (1. - c[i]) + 1.1 * c[i]);
            }
        } else {
            for i in 0..3 {
                c[i] *= 0.7 * (1. - c[3]) + c[3];
            }
        }
        if column[5] != 0 {
            let overlay = color(get(5)?, column[3], vivid);
            let alpha = overlay[3] * 0.65;
            for i in 0..3 {
                c[i] = c[i] * (1. - alpha) + overlay[i] * alpha;
            }
        }
        let l = c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
        let sand = vivid && column[7] == 0 && top.name.eq_ignore_ascii_case("sand");
        for i in 0..3 {
            out[i] = (if vivid {
                (l + (c[i] - l) * 1.08) * 1.04
            } else {
                c[i]
            })
            .clamp(0., 1.)
                * if sand { 0.88 } else { 1. };
        }
    }
    Ok(result)
}
