pub const SHADOW_SHADER: &str = include_str!("shadow.wgsl");
pub const APPEARANCE_SHADER: &str = include_str!("appearance.wgsl");
pub const TERRAIN_SHADER: &str = concat!(
    include_str!("appearance.wgsl"),
    "\n",
    include_str!("shadow.wgsl"),
    "\n",
    include_str!("terrain.wgsl")
);
pub const OVERVIEW_SHADER: &str = concat!(
    include_str!("appearance.wgsl"),
    "\n",
    include_str!("shadow.wgsl"),
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
            let code = format!(
                "{}\n{}\n{}",
                APPEARANCE_SHADER,
                SHADOW_SHADER,
                r#"
@group(0) @binding(0) var<uniform> p:Params;
@group(0) @binding(1) var<storage,read> heights:HeightTree;
@group(0) @binding(2) var<storage,read_write> result:array<f32>;
@compute @workgroup_size(64) fn check(@builtin(global_invocation_id) gid:vec3u) {
    let i=gid.x;let w=u32(p.bounds.z);if i>=w*u32(p.bounds.w){return;}
    let cell=vec2u(i%w,i/w);let y=maximum_height(0u,cell);
    let samples=array<vec2f,5>(vec2f(0.17,0.31),vec2f(0.55,0.8),vec2f(0.9,0.12),vec2f(0.25),vec2f(0.75));
    for(var n=0u;n<5u;n++){result[i*5u+n]=select(ray_shadow(vec2f(cell)+samples[n],y),0.0,y< -900000.0);}
}
"#
            );
            let pipeline = compute_pipeline(&device, "azimuth ray tests", &code, "check");
            let samples = [
                [0.17, 0.31],
                [0.55, 0.8],
                [0.9, 0.12],
                [0.25, 0.25],
                [0.75, 0.75],
            ];
            for (kind, w, h) in [
                ("flat", 17usize, 11usize),
                ("column", 23, 19),
                ("terrace", 33, 21),
                ("boundary", 300, 17),
                ("random", 29, 23),
            ] {
                let mut values = vec![-3f32; w * h];
                let mut seed = 719u32;
                for z in 0..h {
                    for x in 0..w {
                        if kind == "terrace" {
                            values[z * w + x] = ((x / 3 + z / 4) as f32) - 7.;
                        }
                        if kind == "random" {
                            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                            values[z * w + x] = if seed.is_multiple_of(11) {
                                -1e6
                            } else {
                                (seed % 320) as f32 / 16. - 6.
                            };
                        }
                    }
                }
                if kind == "column" {
                    values[(h / 2) * w + w / 2] = 7.;
                }
                if kind == "boundary" {
                    values[8 * w + 254] = 7.;
                    values[8 * w + 255] = -1e6;
                }
                let tree = surface_core::height_pyramid(&values, w, h);
                let input = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: None,
                    contents: bytemuck::cast_slice(&tree),
                    usage: wgpu::BufferUsages::STORAGE,
                });
                let output = device.create_buffer(&wgpu::BufferDescriptor {
                    label: None,
                    size: (w * h * 5 * 4) as u64,
                    usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
                    mapped_at_creation: false,
                });
                let readback = device.create_buffer(&wgpu::BufferDescriptor {
                    label: None,
                    size: output.size(),
                    usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
                    mapped_at_creation: false,
                });
                for azimuth in [
                    0f32, 1., 17., 45., 89., 90., 135., 179., 180., 225., 270., 315., 359., 360.,
                ] {
                    for elevation in [15f32, 45., 60., 75.] {
                        let direction = surface_core::sun_direction(azimuth);
                        let slope = elevation.to_radians().tan();
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
                            w as f32,
                            h as f32,
                            0.55,
                            1.,
                            direction[0],
                            direction[1],
                        ];
                        let uniform =
                            device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                                label: None,
                                contents: bytemuck::cast_slice(&params),
                                usage: wgpu::BufferUsages::UNIFORM,
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
                            pass.dispatch_workgroups((w * h).div_ceil(64) as u32, 1, 1);
                        }
                        encoder.copy_buffer_to_buffer(&output, 0, &readback, 0, output.size());
                        queue.submit([encoder.finish()]);
                        let (tx, rx) = std::sync::mpsc::channel();
                        readback.slice(..).map_async(wgpu::MapMode::Read, move |r| {
                            tx.send(r).unwrap();
                        });
                        device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
                        rx.recv().unwrap().unwrap();
                        let mapped = readback.slice(..).get_mapped_range().unwrap();
                        let actual: &[f32] = bytemuck::cast_slice(&mapped);
                        for (i, y) in values.iter().enumerate() {
                            for (n, uv) in samples.iter().enumerate() {
                                let expected = if *y < -900000. {
                                    0.
                                } else {
                                    surface_core::ray_shadow_reference(
                                        &values,
                                        [w, h],
                                        [(i % w) as f32 + uv[0], (i / w) as f32 + uv[1]],
                                        *y,
                                        direction,
                                        slope,
                                    )
                                };
                                assert_eq!(
                                    actual[i * 5 + n],
                                    expected,
                                    "{kind}, azimuth={azimuth}, elevation={elevation}, cell={i}, sample={n}"
                                );
                            }
                        }
                        drop(mapped);
                        readback.unmap();
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
