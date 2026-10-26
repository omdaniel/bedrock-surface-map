//! GPU-resident max-height pyramid using `surface_core::height_pyramid`'s layout.

use anyhow::{Context, Result, ensure};
use wgpu::util::DeviceExt;

const MAX_SAMPLES: usize = 16 * 1024 * 1024;
const METADATA_WORDS: usize = 128;
const WORKGROUP_SIZE: u32 = 64;

const HEIGHT_MIP_SHADER: &str = r#"
struct HeightTree { levels: array<vec4u, 32>, data: array<f32> }
@group(0) @binding(0) var<storage, read_write> heights: HeightTree;
@group(0) @binding(1) var<uniform> mip: vec4u;

@compute @workgroup_size(64)
fn height_mip(
    @builtin(workgroup_id) group: vec3u,
    @builtin(num_workgroups) groups: vec3u,
    @builtin(local_invocation_index) local: u32,
) {
    // Flatten a 2D dispatch so long, thin fields also fit dispatch limits.
    let index = (group.y * groups.x + group.x) * 64u + local;
    let source = heights.levels[mip.x - 1u];
    let dest = heights.levels[mip.x];
    if index >= dest.y * dest.z { return; }
    let origin = vec2u(index % dest.y, index / dest.y) * 2u;
    // Match the CPU reducer's initial maximum, including inputs below -1e6.
    var maximum = -1000000.0;
    for (var dz = 0u; dz < 2u; dz++) {
        for (var dx = 0u; dx < 2u; dx++) {
            let child = origin + vec2u(dx, dz);
            if child.x < source.y && child.y < source.z {
                maximum = max(maximum, heights.data[source.x + child.y * source.y + child.x]);
            }
        }
    }
    // Source and destination occupy disjoint ranges. Each invocation owns one
    // parent; the next level runs in a separate pass for storage visibility.
    heights.data[dest.x + index] = maximum;
}
"#;

fn sample_count(width: usize, height: usize) -> Result<usize> {
    ensure!(width > 0 && height > 0, "height dimensions must be nonzero");
    let count = width
        .checked_mul(height)
        .context("height dimensions overflow")?;
    ensure!(count <= MAX_SAMPLES, "height field exceeds 16M samples");
    Ok(count)
}

fn validate_values(values: &[f32], count: usize) -> Result<()> {
    ensure!(
        values.len() == count,
        "height length does not match dimensions"
    );
    ensure!(
        values.iter().all(|value| value.is_finite()),
        "heights must be finite"
    );
    Ok(())
}

fn layout(width: usize, height: usize) -> Result<([u32; METADATA_WORDS], usize)> {
    sample_count(width, height)?;
    let mut metadata = [0; METADATA_WORDS];
    let (mut width, mut height, mut level, mut offset) = (width, height, 0, 0);
    loop {
        metadata[level * 4] = offset as u32;
        metadata[level * 4 + 1] = width as u32;
        metadata[level * 4 + 2] = height as u32;
        offset += width * height;
        level += 1;
        if width == 1 && height == 1 {
            break;
        }
        width = width.div_ceil(2);
        height = height.div_ceil(2);
    }
    // The sample cap permits at most 25 levels and < 2^26 data words.
    metadata[127] = level as u32;
    Ok((metadata, (METADATA_WORDS + offset) * size_of::<u32>()))
}

struct MipLevel {
    group: wgpu::BindGroup,
    dispatch: [u32; 2],
}

/// Owns the full height tree on the GPU, with no retained CPU height samples.
/// Metadata is 32 vec4<u32> descriptors followed by contiguous f32 levels, as
/// consumed by the renderer's `HeightTree`. Each descriptor stores a data-word
/// offset, width, height, and zero; word 127 stores the level count.
pub struct HeightField {
    pub buffer: wgpu::Buffer,
    width: usize,
    height: usize,
    pipeline: wgpu::ComputePipeline,
    levels: Vec<MipLevel>,
}

impl HeightField {
    /// GPU allocation size, validated without creating a buffer.
    pub fn allocation_bytes(width: usize, height: usize) -> Result<usize> {
        Ok(layout(width, height)?.1)
    }

    /// Upload only metadata and leaf values, then submit GPU construction of all
    /// parent levels. Dimensions must be nonzero, contain <= 16M finite samples,
    /// and fit the supplied device's storage-buffer and compute limits.
    pub fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        width: usize,
        height: usize,
        values: &[f32],
    ) -> Result<Self> {
        let (metadata, bytes) = layout(width, height)?;
        validate_values(values, width * height)?;
        let limits = device.limits();
        ensure!(
            bytes as u64 <= limits.max_buffer_size,
            "height tree exceeds device buffer limit"
        );
        ensure!(
            bytes as u64 <= limits.max_storage_buffer_binding_size,
            "height tree exceeds device storage-binding limit"
        );
        ensure!(
            limits.max_compute_workgroup_size_x >= WORKGROUP_SIZE
                && limits.max_compute_invocations_per_workgroup >= WORKGROUP_SIZE
                && limits.max_compute_workgroups_per_dimension > 0,
            "device does not support height mip workgroups"
        );
        let limit = limits.max_compute_workgroups_per_dimension;
        let mut dispatches = Vec::with_capacity(metadata[127] as usize - 1);
        for level in 1..metadata[127] as usize {
            let count = metadata[level * 4 + 1] * metadata[level * 4 + 2];
            let groups = count.div_ceil(WORKGROUP_SIZE);
            let x = groups.min(limit);
            let y = groups.div_ceil(x);
            ensure!(y <= limit, "height level exceeds device dispatch limit");
            dispatches.push([x, y]);
        }

        let buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("height field"),
            size: bytes as u64,
            usage: wgpu::BufferUsages::STORAGE
                | wgpu::BufferUsages::COPY_DST
                | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        queue.write_buffer(&buffer, 0, bytemuck::cast_slice(&metadata));
        queue.write_buffer(
            &buffer,
            (METADATA_WORDS * size_of::<u32>()) as u64,
            bytemuck::cast_slice(values),
        );
        let pipeline =
            crate::compute_pipeline(device, "height mip", HEIGHT_MIP_SHADER, "height_mip");
        let group_layout = pipeline.get_bind_group_layout(0);
        let levels = dispatches
            .into_iter()
            .enumerate()
            .map(|(index, dispatch)| {
                let uniform = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("height mip level"),
                    contents: bytemuck::cast_slice(&[index as u32 + 1, 0, 0, 0]),
                    usage: wgpu::BufferUsages::UNIFORM,
                });
                let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("height mip"),
                    layout: &group_layout,
                    entries: &[
                        wgpu::BindGroupEntry {
                            binding: 0,
                            resource: buffer.as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: 1,
                            resource: uniform.as_entire_binding(),
                        },
                    ],
                });
                MipLevel { group, dispatch }
            })
            .collect();
        let field = Self {
            buffer,
            width,
            height,
            pipeline,
            levels,
        };
        field.rebuild(device, queue);
        Ok(field)
    }

    /// Size of the packed GPU tree, including its 128 metadata words.
    pub fn bytes(&self) -> usize {
        self.buffer.size() as usize
    }

    /// Queue writes to leaf rows only. Validate the entire patch before writing
    /// any row. The owner must call `rebuild` after its batch of patches and
    /// before submitting overview/shadow work that reads parent levels.
    pub fn patch(
        &self,
        queue: &wgpu::Queue,
        x: usize,
        z: usize,
        width: usize,
        height: usize,
        values: &[f32],
    ) -> Result<()> {
        validate_values(values, sample_count(width, height)?)?;
        ensure!(
            x.checked_add(width).is_some_and(|end| end <= self.width)
                && z.checked_add(height).is_some_and(|end| end <= self.height),
            "height patch is outside the field"
        );
        for row in 0..height {
            let offset = METADATA_WORDS + (z + row) * self.width + x;
            queue.write_buffer(
                &self.buffer,
                (offset * size_of::<u32>()) as u64,
                bytemuck::cast_slice(&values[row * width..(row + 1) * width]),
            );
        }
        Ok(())
    }

    /// Recompute every parent level in sequential compute passes and submit
    /// them after pending leaf writes. Use the device/queue that created this
    /// field. Subsequent work on that queue sees the rebuilt tree without a CPU
    /// wait or readback, including when a patch lowers a previous maximum.
    pub fn rebuild(&self, device: &wgpu::Device, queue: &wgpu::Queue) {
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("rebuild height field"),
        });
        for level in &self.levels {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("height mip level"),
                ..Default::default()
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &level.group, &[]);
            pass.dispatch_workgroups(level.dispatch[0], level.dispatch[1], 1);
        }
        queue.submit([encoder.finish()]);
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;

    async fn gpu() -> (wgpu::Device, wgpu::Queue) {
        let instance = wgpu::Instance::default();
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions::default())
            .await
            .expect("GPU or software Vulkan adapter required for GPU tests");
        eprintln!("HeightField test adapter: {:?}", adapter.get_info());
        adapter
            .request_device(&wgpu::DeviceDescriptor {
                // Exercise dispatch splitting with a small fixture.
                required_limits: wgpu::Limits {
                    max_compute_workgroups_per_dimension: 32,
                    ..Default::default()
                },
                ..Default::default()
            })
            .await
            .unwrap()
    }

    fn readback(device: &wgpu::Device, queue: &wgpu::Queue, field: &HeightField) -> Vec<u32> {
        let buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("height tree test readback"),
            size: field.buffer.size(),
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let mut encoder = device.create_command_encoder(&Default::default());
        encoder.copy_buffer_to_buffer(&field.buffer, 0, &buffer, 0, field.buffer.size());
        queue.submit([encoder.finish()]);
        let (tx, rx) = std::sync::mpsc::channel();
        buffer
            .slice(..)
            .map_async(wgpu::MapMode::Read, move |result| {
                tx.send(result).unwrap();
            });
        device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
        rx.recv().unwrap().unwrap();
        let mapped = buffer.slice(..).get_mapped_range().unwrap();
        let words = bytemuck::cast_slice(&mapped).to_vec();
        drop(mapped);
        buffer.unmap();
        words
    }

    #[test]
    fn gpu_height_tree_matches_cpu_before_and_after_leaf_patches() {
        pollster::block_on(async {
            let (device, queue) = gpu().await;
            for (kind, width, height) in [
                ("single below sentinel", 1, 1),
                ("horizontal", 17, 1),
                ("vertical", 1, 19),
                ("negative odd rectangle", 7, 5),
                ("all missing", 5, 3),
                ("split dispatch", 129, 65),
            ] {
                let mut values: Vec<_> = (0..width * height)
                    .map(|i| {
                        if kind == "all missing" || kind == "single below sentinel" || i % 13 == 0 {
                            -2e6
                        } else if i % 7 == 0 {
                            -1e6
                        } else if i % 17 == 0 {
                            -950_000.
                        } else {
                            -20. + (i % 256) as f32 / 16.
                        }
                    })
                    .collect();
                if width * height > 1 && kind != "all missing" {
                    values[0] = -1.25;
                    values[width * height - 1] = -2.5;
                }
                let field = HeightField::new(&device, &queue, width, height, &values).unwrap();
                let initial = surface_core::height_pyramid(&values, width, height);
                assert_eq!(field.bytes(), initial.len() * size_of::<u32>());
                assert_eq!(readback(&device, &queue, &field), initial, "initial {kind}");
                if kind == "split dispatch" {
                    assert!(field.levels[0].dispatch[1] > 1);
                }

                // Batch disjoint/overlapping patches, including odd edges and a
                // lowered old maximum. No parent word may change before rebuild.
                let (pw, ph) = (width.min(3), height.min(2));
                let patch = vec![-2e6; pw * ph];
                field.patch(&queue, 0, 0, pw, ph, &patch).unwrap();
                for row in 0..ph {
                    values[row * width..row * width + pw]
                        .copy_from_slice(&patch[row * pw..(row + 1) * pw]);
                }
                let (pw, ph) = (width.min(2), height.min(3));
                let (x, z) = (width - pw, height - ph);
                let patch: Vec<_> = (0..pw * ph)
                    .map(|i| if i % 2 == 0 { -0.25 } else { -1e6 })
                    .collect();
                field.patch(&queue, x, z, pw, ph, &patch).unwrap();
                for row in 0..ph {
                    values[(z + row) * width + x..(z + row) * width + x + pw]
                        .copy_from_slice(&patch[row * pw..(row + 1) * pw]);
                }
                let mut pending = initial;
                for (word, value) in pending[METADATA_WORDS..METADATA_WORDS + values.len()]
                    .iter_mut()
                    .zip(&values)
                {
                    *word = value.to_bits();
                }
                assert_eq!(
                    readback(&device, &queue, &field),
                    pending,
                    "leaf-only patches {kind}"
                );
                field.rebuild(&device, &queue);
                assert_eq!(
                    readback(&device, &queue, &field),
                    surface_core::height_pyramid(&values, width, height),
                    "rebuilt {kind}"
                );

                // Removing every maximum must clamp parent cells to the CPU's
                // missing sentinel while preserving the lower leaf values.
                values.fill(-2e6);
                field.patch(&queue, 0, 0, width, height, &values).unwrap();
                field.rebuild(&device, &queue);
                assert_eq!(
                    readback(&device, &queue, &field),
                    surface_core::height_pyramid(&values, width, height),
                    "cleared {kind}"
                );
            }
        });
    }

    #[test]
    fn invalid_inputs_and_patches_are_rejected_without_partial_writes() {
        pollster::block_on(async {
            let (device, queue) = gpu().await;
            for (width, height) in [
                (0, 1),
                (1, 0),
                (usize::MAX, 2),
                (MAX_SAMPLES + 1, 1),
                (2, 2),
            ] {
                assert!(HeightField::new(&device, &queue, width, height, &[]).is_err());
            }
            for value in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
                assert!(HeightField::new(&device, &queue, 1, 1, &[value]).is_err());
            }
            let values = [-3.; 12];
            let field = HeightField::new(&device, &queue, 4, 3, &values).unwrap();
            for (x, z, width, height) in [
                (0, 0, 0, 1),
                (0, 0, 1, 0),
                (4, 0, 1, 1),
                (0, 3, 1, 1),
                (3, 2, 2, 1),
                (3, 2, 1, 2),
                (usize::MAX, 0, 1, 1),
                (0, usize::MAX, 1, 1),
            ] {
                let patch = vec![9.; width * height];
                assert!(field.patch(&queue, x, z, width, height, &patch).is_err());
            }
            assert!(field.patch(&queue, 0, 0, usize::MAX, 2, &[]).is_err());
            assert!(field.patch(&queue, 0, 0, 2, 2, &[9.; 3]).is_err());
            assert!(field.patch(&queue, 0, 0, 2, 2, &[9.; 5]).is_err());
            for invalid in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
                // Invalid final row must not leave a valid first row queued.
                assert!(
                    field
                        .patch(&queue, 1, 1, 2, 2, &[9., 9., 9., invalid])
                        .is_err()
                );
            }
            field.rebuild(&device, &queue);
            assert_eq!(
                readback(&device, &queue, &field),
                surface_core::height_pyramid(&values, 4, 3)
            );
        });
    }

    #[test]
    fn layout_is_bounded_even_for_maximum_thin_fields() {
        for (width, height) in [(0, 1), (1, 0), (usize::MAX, 2), (MAX_SAMPLES + 1, 1)] {
            assert!(layout(width, height).is_err());
        }
        for (width, height) in [(MAX_SAMPLES, 1), (1, MAX_SAMPLES)] {
            let (metadata, bytes) = layout(width, height).unwrap();
            assert_eq!(metadata[127], 25);
            assert_eq!(metadata[24 * 4 + 1..24 * 4 + 3], [1, 1]);
            assert!(metadata[25 * 4..127].iter().all(|word| *word == 0));
            assert_eq!(
                bytes,
                (METADATA_WORDS + 2 * MAX_SAMPLES - 1) * size_of::<u32>()
            );
        }
        let (metadata, _) = layout(4096, 4096).unwrap();
        assert_eq!(metadata[127], 13);
    }
}
