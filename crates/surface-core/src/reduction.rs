//! Bounded, row-major reduction directly from full-resolution surface samples.

use anyhow::{Context, Result, ensure};
use std::cmp::Reverse;

const MAX_SAMPLES: usize = 16 * 1024 * 1024;
const WORDS_PER_CELL: usize = 8;
const MISSING_HEIGHT: f32 = -1_000_000.;
const MIN_PRESENT_HEIGHT: f32 = -900_000.;

fn sample_count(width: usize, height: usize, stride: usize) -> Result<usize> {
    ensure!(matches!(stride, 1 | 2 | 4), "stride must be 1, 2, or 4");
    ensure!(width > 0 && height > 0, "dimensions must be nonzero");
    ensure!(
        width.is_multiple_of(stride) && height.is_multiple_of(stride),
        "dimensions must be divisible by stride"
    );
    let count = width.checked_mul(height).context("dimensions overflow")?;
    ensure!(count <= MAX_SAMPLES, "surface exceeds 16M samples");
    Ok(count)
}

#[derive(Clone, Copy, Default)]
struct MaterialCandidate {
    material: u32,
    count: u32,
    representative: usize,
    distance: usize,
}

/// Reduce a square surface of eight words per cell:
/// `[height (signed sixteenths), material, tint, overlay, depth, support,
/// overlay_height, coverage]`.
///
/// Inputs use full-resolution coverage: 0 unavailable, 1 present, 2 verified
/// empty. Stride 1 returns an exact clone. For larger strides, select the modal
/// present material, breaking ties by its closest sample to the block center,
/// then by row-major sample order. Copy that sample's attributes, but replace
/// height with the mean of *all* present heights, rounded to the nearest signed
/// sixteenth (halfway values away from zero).
///
/// Present output coverage is `(present_count << 8) | 1`; divide that count by
/// `stride * stride` for the fraction. With no present samples, other words are
/// zero and coverage is 2 only if every member is verified empty, otherwise 0.
/// Always reduce from the original samples, not a previously reduced surface.
pub fn reduce_words(words: &[u32], side: usize, stride: usize) -> Result<Vec<u32>> {
    let count = sample_count(side, side, stride)?;
    ensure!(
        words.len() == count * WORDS_PER_CELL,
        "word length does not match dimensions"
    );
    if stride == 1 {
        return Ok(words.to_vec());
    }

    let coarse_side = side / stride;
    let mut reduced = Vec::with_capacity(coarse_side * coarse_side * WORDS_PER_CELL);
    for z in (0..side).step_by(stride) {
        for x in (0..side).step_by(stride) {
            // At most 16 distinct materials; no per-block heap allocation.
            let mut candidates = [MaterialCandidate::default(); 16];
            let mut material_count = 0;
            let mut present_count = 0u32;
            let mut height_sum = 0i64;
            let mut all_empty = true;
            for dz in 0..stride {
                for dx in 0..stride {
                    let index = ((z + dz) * side + x + dx) * WORDS_PER_CELL;
                    let coverage = words[index + 7];
                    all_empty &= coverage == 2;
                    if coverage != 1 {
                        continue;
                    }
                    present_count += 1;
                    height_sum += i64::from(words[index] as i32);

                    // Doubled coordinates avoid fractional center distances.
                    let cx = (2 * dx).abs_diff(stride - 1);
                    let cz = (2 * dz).abs_diff(stride - 1);
                    let distance = cx * cx + cz * cz;
                    let material = words[index + 1];
                    if let Some(candidate) = candidates[..material_count]
                        .iter_mut()
                        .find(|candidate| candidate.material == material)
                    {
                        candidate.count += 1;
                        if distance < candidate.distance {
                            candidate.distance = distance;
                            candidate.representative = index;
                        }
                    } else {
                        candidates[material_count] = MaterialCandidate {
                            material,
                            count: 1,
                            representative: index,
                            distance,
                        };
                        material_count += 1;
                    }
                }
            }

            let mut cell = [0; WORDS_PER_CELL];
            if let Some(candidate) = candidates[..material_count].iter().min_by_key(|candidate| {
                (
                    Reverse(candidate.count),
                    candidate.distance,
                    candidate.representative,
                )
            }) {
                cell.copy_from_slice(
                    &words[candidate.representative..candidate.representative + WORDS_PER_CELL],
                );
                cell[0] = (height_sum as f64 / f64::from(present_count)).round() as i32 as u32;
                cell[7] = (present_count << 8) | 1;
            } else if all_empty {
                cell[7] = 2;
            }
            reduced.extend_from_slice(&cell);
        }
    }
    Ok(reduced)
}

/// Reduce a rectangular height field by averaging samples >= -900000 in each
/// stride-sized block. All input values must be finite, including missing ones.
/// Empty blocks yield -1000000. Stride 1 preserves the exact input values.
/// Both helpers accept strides 1, 2, and 4, nonzero divisible dimensions, and
/// at most 16 * 1024 * 1024 input samples.
pub fn reduce_heights(
    heights: &[f32],
    width: usize,
    height: usize,
    stride: usize,
) -> Result<Vec<f32>> {
    let count = sample_count(width, height, stride)?;
    ensure!(
        heights.len() == count,
        "height length does not match dimensions"
    );
    ensure!(
        heights.iter().all(|value| value.is_finite()),
        "heights must be finite"
    );
    if stride == 1 {
        return Ok(heights.to_vec());
    }

    let mut reduced = Vec::with_capacity((width / stride) * (height / stride));
    for z in (0..height).step_by(stride) {
        for x in (0..width).step_by(stride) {
            let mut sum = 0f64;
            let mut present = 0u32;
            for dz in 0..stride {
                for dx in 0..stride {
                    let value = heights[(z + dz) * width + x + dx];
                    if value >= MIN_PRESENT_HEIGHT {
                        sum += f64::from(value);
                        present += 1;
                    }
                }
            }
            reduced.push(if present == 0 {
                MISSING_HEIGHT
            } else {
                (sum / f64::from(present)) as f32
            });
        }
    }
    Ok(reduced)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cell(height: i32, material: u32, tag: u32, coverage: u32) -> [u32; 8] {
        [
            height as u32,
            material,
            tag,
            tag + 1,
            tag + 2,
            tag + 3,
            tag + 4,
            coverage,
        ]
    }

    fn flatten(cells: &[[u32; 8]]) -> Vec<u32> {
        cells.iter().flatten().copied().collect()
    }

    #[test]
    fn stride_one_is_exact_identity() {
        let words = flatten(&[
            cell(-17, 4, 20, 1),
            cell(19, 8, 40, 2),
            cell(i32::MIN, 12, 60, 0),
            cell(i32::MAX, 16, 80, 0x1001),
        ]);
        assert_eq!(reduce_words(&words, 2, 1).unwrap(), words);
        let heights = [-0., -1.0625, -999_999., MISSING_HEIGHT, -900_000., 1.1875];
        let actual = reduce_heights(&heights, 3, 2, 1).unwrap();
        assert_eq!(
            actual.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
            heights.iter().map(|v| v.to_bits()).collect::<Vec<_>>()
        );
    }

    #[test]
    fn word_means_preserve_signed_fractional_heights_and_round_away_from_zero() {
        for (heights, expected) in [
            ([-17, -18, -19, -20], -19),
            ([17, 18, 19, 20], 19),
            ([-1, -1, 0, 0], -1),
            ([1, 1, 0, 0], 1),
            ([i32::MIN, i32::MAX, i32::MIN, i32::MAX], -1),
            ([i32::MIN; 4], i32::MIN),
            ([i32::MAX; 4], i32::MAX),
        ] {
            let words = flatten(&heights.map(|height| cell(height, 3, 10, 1)));
            let reduced = reduce_words(&words, 2, 2).unwrap();
            assert_eq!(reduced[0] as i32, expected);
            assert_eq!(reduced[7], (4 << 8) | 1);
        }
    }

    #[test]
    fn modal_material_wins_but_height_includes_every_present_material() {
        let mut cells = [cell(100_000, 99, 90, 0); 16];
        for i in [0, 3, 4, 15] {
            cells[i] = cell(0, 7, 10 + i as u32, 1);
        }
        for i in [5, 6, 9] {
            cells[i] = cell(160, 2, 30 + i as u32, 1);
        }
        let actual = reduce_words(&flatten(&cells), 4, 4).unwrap();
        assert_eq!(&actual[1..7], &cells[4][1..7]);
        assert_eq!(actual[0] as i32, 69); // round(3 * 160 / 7), not the modal height.
        assert_eq!(actual[7], (7 << 8) | 1);
    }

    #[test]
    fn tied_materials_choose_center_nearest_then_row_major_sample() {
        let mut cells = [cell(0, 0, 0, 0); 16];
        cells[0] = cell(0, 30, 10, 1);
        cells[1] = cell(0, 30, 20, 1);
        cells[5] = cell(0, 20, 30, 1);
        cells[15] = cell(0, 20, 40, 1);
        let actual = reduce_words(&flatten(&cells), 4, 4).unwrap();
        assert_eq!(&actual[1..7], &cells[5][1..7]);

        cells[1][7] = 0;
        cells[5] = cell(0, 30, 50, 1);
        cells[6] = cell(0, 20, 60, 1);
        let actual = reduce_words(&flatten(&cells), 4, 4).unwrap();
        assert_eq!(&actual[1..7], &cells[5][1..7]);

        let cells = [
            cell(0, 9, 10, 1),
            cell(0, 3, 20, 1),
            cell(0, 3, 30, 1),
            cell(0, 9, 40, 1),
        ];
        let actual = reduce_words(&flatten(&cells), 2, 2).unwrap();
        assert_eq!(&actual[1..7], &cells[0][1..7]);
    }

    #[test]
    fn water_and_overlay_attributes_come_from_one_real_representative() {
        let cells: Vec<_> = (0..16)
            .map(|i| {
                [
                    i * 16,
                    8,
                    0x102030 + i,
                    100 + i,
                    2 + i,
                    200 + i,
                    (-32 - i as i32) as u32,
                    1,
                ]
            })
            .collect();
        let actual = reduce_words(&flatten(&cells), 4, 4).unwrap();
        assert_eq!(&actual[1..7], &cells[5][1..7]);
        assert_eq!(actual[0], 120);
        assert_eq!(actual[7], (16 << 8) | 1);
    }

    #[test]
    fn partial_present_verified_empty_and_unavailable_stay_distinct() {
        let mut cells = [cell(i32::MAX, 99, 90, 0); 16];
        cells[0] = cell(-32, 7, 10, 1);
        cells[5] = cell(64, 7, 20, 1);
        for i in [2, 3, 4, 6, 7, 8, 12, 13] {
            cells[i][7] = 2;
        }
        let actual = reduce_words(&flatten(&cells), 4, 2).unwrap();
        let mut present = cells[0];
        present[0] = 16;
        present[7] = (2 << 8) | 1;
        let mut empty = [0; 8];
        empty[7] = 2;
        assert_eq!(actual, flatten(&[present, empty, [0; 8], [0; 8]]));
    }

    #[test]
    fn height_means_keep_negative_fractions_and_do_not_overflow_f32() {
        assert_eq!(
            reduce_heights(&[-1.25, -2.5, 0.25, 1.], 2, 2, 2).unwrap(),
            [-0.625]
        );
        for stride in [2, 4] {
            let heights = vec![f32::MAX; stride * stride];
            assert_eq!(
                reduce_heights(&heights, stride, stride, stride).unwrap(),
                [f32::MAX]
            );
        }
    }

    #[test]
    fn rectangular_heights_include_threshold_and_ignore_missing_samples() {
        let heights = [
            -900_000.,
            -999_999.,
            MISSING_HEIGHT,
            -900_001.,
            -899_999.,
            MISSING_HEIGHT,
            -999_999.,
            f32::MIN,
        ];
        assert_eq!(
            reduce_heights(&heights, 4, 2, 2).unwrap(),
            [-899_999.5, MISSING_HEIGHT]
        );
    }

    #[test]
    fn diagonal_steps_average_to_a_linear_sampled_transition() {
        for stride in [2, 4] {
            let side = 3 * stride;
            let heights: Vec<_> = (0..side)
                .flat_map(|z| (0..side).map(move |x| ((x + z) / stride) as f32))
                .collect();
            let words = flatten(
                &heights
                    .iter()
                    .map(|y| cell((y * 16.) as i32, 1, 10, 1))
                    .collect::<Vec<_>>(),
            );
            let reduced_heights = reduce_heights(&heights, side, side, stride).unwrap();
            let reduced_words = reduce_words(&words, side, stride).unwrap();
            let offset = if stride == 2 { 0.25 } else { 0.375 };
            for z in 0..3 {
                for x in 0..3 {
                    // Every step in either axis advances exactly one block;
                    // the fractional offset retains the diagonal's subcell mean.
                    let expected = (x + z) as f32 + offset;
                    assert_eq!(reduced_heights[z * 3 + x], expected);
                    assert_eq!(
                        reduced_words[(z * 3 + x) * 8] as i32,
                        (expected * 16.) as i32
                    );
                }
            }
        }
    }

    #[test]
    fn invalid_dimensions_strides_and_lengths_are_rejected() {
        for stride in [0, 3, 8, usize::MAX] {
            assert!(reduce_words(&[0; 32], 2, stride).is_err());
            assert!(reduce_heights(&[0.; 4], 2, 2, stride).is_err());
        }
        for (width, height, stride) in [
            (0, 2, 1),
            (2, 0, 1),
            (3, 2, 2),
            (2, 3, 2),
            (4, 6, 4),
            (usize::MAX, 2, 1),
        ] {
            assert!(reduce_heights(&[], width, height, stride).is_err());
        }
        for (side, stride) in [(0, 1), (3, 2), (6, 4), (usize::MAX, 1), (4097, 1)] {
            assert!(reduce_words(&[], side, stride).is_err());
        }
        for stride in [1, 2] {
            for len in [0, 31, 33] {
                assert!(reduce_words(&vec![0; len], 2, stride).is_err());
            }
            for len in [0, 3, 5] {
                assert!(reduce_heights(&vec![0.; len], 2, 2, stride).is_err());
            }
        }
        assert_eq!(sample_count(4096, 4096, 4).unwrap(), MAX_SAMPLES);
        assert_eq!(sample_count(MAX_SAMPLES, 1, 1).unwrap(), MAX_SAMPLES);
        assert!(sample_count(4096, 4097, 1).is_err());
        assert!(reduce_heights(&[], MAX_SAMPLES + 1, 1, 1).is_err());
    }

    #[test]
    fn nonfinite_heights_are_rejected_even_for_identity_or_missing_blocks() {
        for value in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            for stride in [1, 2, 4] {
                let mut heights = vec![MISSING_HEIGHT; 16];
                heights[15] = value;
                assert!(reduce_heights(&heights, 4, 4, stride).is_err());
            }
        }
    }
}
