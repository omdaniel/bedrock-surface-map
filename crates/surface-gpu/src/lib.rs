pub const SHADOW_SHADER: &str = include_str!("shadow.wgsl");
pub const TERRAIN_SHADER: &str = include_str!("terrain.wgsl");
pub const OVERVIEW_SHADER: &str = include_str!("overview.wgsl");
pub const MIP_SHADER: &str = include_str!("mip.wgsl");

pub fn compute_pipeline(
    device: &wgpu::Device,
    label: &str,
    code: &str,
    entry: &str,
) -> wgpu::ComputePipeline {
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some(label),
        source: wgpu::ShaderSource::Wgsl(code.into()),
    });
    device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some(label),
        layout: None,
        module: &module,
        entry_point: Some(entry),
        compilation_options: Default::default(),
        cache: None,
    })
}

#[cfg(target_arch = "wasm32")]
mod browser;
#[cfg(target_arch = "wasm32")]
pub use browser::*;

#[cfg(test)]
mod tests {
    use super::*;
    use wgpu::util::DeviceExt;
    #[test]
    fn gpu_shadows_match_cpu() {
        pollster::block_on(async {
            let instance = wgpu::Instance::default();
            let adapter = instance
                .request_adapter(&wgpu::RequestAdapterOptions::default())
                .await
                .expect("GPU or software Vulkan adapter required for GPU tests");
            let (device, queue) = adapter
                .request_device(&wgpu::DeviceDescriptor::default())
                .await
                .unwrap();
            let pipeline = compute_pipeline(&device, "shadow test", SHADOW_SHADER, "shadow");
            for (kind, size) in [
                ("flat", 16usize),
                ("column", 16),
                ("terrace", 16),
                ("boundary", 300),
            ] {
                let mut heights = vec![0i16; size * size];
                if kind == "terrace" {
                    for z in 0..size {
                        for x in 0..size {
                            heights[z * size + x] = ((x / 3 + z / 4) * 16) as i16;
                        }
                    }
                }
                if kind == "column" {
                    heights[0] = 160;
                }
                if kind == "boundary" {
                    heights[254 * size + 254] = 160;
                    heights[255 * size + 255] = surface_core::MISSING_HEIGHT;
                }
                let floats: Vec<f32> = heights
                    .iter()
                    .map(|h| {
                        if *h == surface_core::MISSING_HEIGHT {
                            -1e6
                        } else {
                            *h as f32 / 16.
                        }
                    })
                    .collect();
                let params = [
                    0.,
                    0.,
                    1.,
                    100.,
                    100.,
                    1.,
                    1.,
                    1.,
                    0.,
                    0.,
                    size as f32,
                    size as f32,
                ];
                let uniform = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: None,
                    contents: bytemuck::cast_slice(&params),
                    usage: wgpu::BufferUsages::UNIFORM,
                });
                let input = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: None,
                    contents: bytemuck::cast_slice(&floats),
                    usage: wgpu::BufferUsages::STORAGE,
                });
                let output = device.create_buffer(&wgpu::BufferDescriptor {
                    label: None,
                    size: (size * size * 4) as u64,
                    usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
                    mapped_at_creation: false,
                });
                let readback = device.create_buffer(&wgpu::BufferDescriptor {
                    label: None,
                    size: output.size(),
                    usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                    mapped_at_creation: false,
                });
                let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: None,
                    layout: &pipeline.get_bind_group_layout(0),
                    entries: &[
                        wgpu::BindGroupEntry {
                            binding: 0,
                            resource: uniform.as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: 1,
                            resource: input.as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: 2,
                            resource: output.as_entire_binding(),
                        },
                    ],
                });
                let mut encoder = device.create_command_encoder(&Default::default());
                {
                    let mut pass = encoder.begin_compute_pass(&Default::default());
                    pass.set_pipeline(&pipeline);
                    pass.set_bind_group(0, &group, &[]);
                    pass.dispatch_workgroups(((size * 2 - 1) as u32).div_ceil(64), 1, 1);
                }
                encoder.copy_buffer_to_buffer(&output, 0, &readback, 0, output.size());
                queue.submit([encoder.finish()]);
                let (tx, rx) = std::sync::mpsc::channel();
                readback.slice(..).map_async(wgpu::MapMode::Read, move |r| {
                    tx.send(r).unwrap();
                });
                device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
                rx.recv().unwrap().unwrap();
                let data = readback.slice(..).get_mapped_range().unwrap();
                let actual: &[f32] = bytemuck::cast_slice(&data);
                assert_eq!(actual, surface_core::shadow_reference(&heights, size, size));
            }
            for (name, code) in [
                ("terrain", TERRAIN_SHADER),
                ("overview", OVERVIEW_SHADER),
                ("mip", MIP_SHADER),
            ] {
                let _ = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                    label: Some(name),
                    source: wgpu::ShaderSource::Wgsl(code.into()),
                });
            }
        });
    }
}
