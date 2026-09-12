pub const SHADOW_SHADER: &str = include_str!("shadow.wgsl");
pub const APPEARANCE_SHADER: &str = include_str!("appearance.wgsl");
pub const TERRAIN_SHADER: &str = concat!(
    include_str!("appearance.wgsl"),
    "\n",
    include_str!("terrain.wgsl")
);
pub const OVERVIEW_SHADER: &str = concat!(
    include_str!("appearance.wgsl"),
    "\n",
    include_str!("overview.wgsl")
);
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
            for (kind, size, elevation) in [
                ("flat", 16usize, 45f32),
                ("column", 16, 60.),
                ("terrace", 16, 45.),
                ("boundary", 300, 60.),
                ("ledge", 16, 45.),
                ("ledge", 16, 60.),
            ] {
                let slope = elevation.to_radians().tan() * std::f32::consts::SQRT_2;
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
                if kind == "ledge" {
                    for z in 0..size {
                        for x in 0..size / 2 {
                            heights[z * size + x] = 16;
                        }
                    }
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
                    slope,
                    0.,
                    0.,
                    size as f32,
                    size as f32,
                    0.55,
                    1.,
                    0.,
                    0.,
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
                let expected = surface_core::horizon_reference(&heights, size, size, slope);
                for (a, b) in actual.iter().zip(&expected) {
                    assert!((a - b).abs() < 0.0001);
                }
                drop(data);
                readback.unmap();

                let coverage_code = format!(
                    "{}\n{}",
                    APPEARANCE_SHADER,
                    r#"
@group(0) @binding(0) var<uniform> p:Params;
@group(0) @binding(1) var<storage,read> heights:array<f32>;
@group(0) @binding(2) var<storage,read> horizon:array<f32>;
@group(0) @binding(3) var<storage,read_write> result:array<f32>;
fn at(x:i32,z:i32)->f32 {
    if x<0 || z<0 {return -1000000.0;}
    return horizon[u32(z)*u32(p.bounds.z)+u32(x)];
}
@compute @workgroup_size(64) fn coverage(@builtin(global_invocation_id) gid:vec3u) {
    let i=gid.x;let w=u32(p.bounds.z);if i>=w*u32(p.bounds.w){return;}
    let x=i32(i%w);let z=i32(i/w);let hs=vec3f(at(x-1,z),at(x,z-1),at(x-1,z-1));
    let lo=array<vec2f,5>(vec2f(0),vec2f(0.05,0.65),vec2f(0.45,0.65),vec2f(0.8,0.2),vec2f(0.45));
    let hi=array<vec2f,5>(vec2f(1),vec2f(0.15,0.75),vec2f(0.55,0.75),vec2f(0.9,0.3),vec2f(0.55));
    for(var n=0u;n<5u;n++){result[i*5u+n]=select(shadow_area(hs,heights[i],p.screen.w,lo[n],hi[n]),0.0,heights[i]<-900000.0);}
}"#
                );
                let coverage = compute_pipeline(
                    &device,
                    "fractional shadow coverage",
                    &coverage_code,
                    "coverage",
                );
                let cov = device.create_buffer(&wgpu::BufferDescriptor {
                    label: None,
                    size: (size * size * 5 * 4) as u64,
                    usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
                    mapped_at_creation: false,
                });
                let cb = device.create_buffer(&wgpu::BufferDescriptor {
                    label: None,
                    size: cov.size(),
                    usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                    mapped_at_creation: false,
                });
                let cg = device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: None,
                    layout: &coverage.get_bind_group_layout(0),
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
                        wgpu::BindGroupEntry {
                            binding: 3,
                            resource: cov.as_entire_binding(),
                        },
                    ],
                });
                let mut encoder = device.create_command_encoder(&Default::default());
                {
                    let mut pass = encoder.begin_compute_pass(&Default::default());
                    pass.set_pipeline(&coverage);
                    pass.set_bind_group(0, &cg, &[]);
                    pass.dispatch_workgroups((size * size).div_ceil(64) as u32, 1, 1);
                }
                encoder.copy_buffer_to_buffer(&cov, 0, &cb, 0, cov.size());
                queue.submit([encoder.finish()]);
                let (tx, rx) = std::sync::mpsc::channel();
                cb.slice(..).map_async(wgpu::MapMode::Read, move |r| {
                    tx.send(r).unwrap();
                });
                device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
                rx.recv().unwrap().unwrap();
                let mapped = cb.slice(..).get_mapped_range().unwrap();
                let pixels: &[f32] = bytemuck::cast_slice(&mapped);
                let footprints = [
                    ([0., 0.], [1., 1.]),
                    ([0.05, 0.65], [0.15, 0.75]),
                    ([0.45, 0.65], [0.55, 0.75]),
                    ([0.8, 0.2], [0.9, 0.3]),
                    ([0.45, 0.45], [0.55, 0.55]),
                ];
                for (i, h) in heights.iter().enumerate() {
                    for (n, (lo, hi)) in footprints.iter().enumerate() {
                        let e = if *h == surface_core::MISSING_HEIGHT {
                            0.
                        } else {
                            surface_core::shadow_coverage_reference(
                                &expected,
                                [size, size],
                                [i % size, i / size],
                                *h as f32 / 16.,
                                slope,
                                *lo,
                                *hi,
                            )
                        };
                        assert!(
                            (pixels[i * 5 + n] - e).abs() < 0.0002,
                            "GPU coverage {kind}/{elevation} at {i}/{n}: {} vs {e}",
                            pixels[i * 5 + n]
                        );
                    }
                }
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
