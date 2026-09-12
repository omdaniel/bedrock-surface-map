pub const SHADOW_SHADER: &str = include_str!("shadow.wgsl");
pub const APPEARANCE_SHADER: &str = include_str!("appearance.wgsl");
pub const RELIEF_SHADER: &str = include_str!("relief.wgsl");
pub const TERRAIN_SHADER: &str = concat!(
    include_str!("appearance.wgsl"),
    "\n",
    include_str!("shadow.wgsl"),
    "\n",
    include_str!("terrain.wgsl"),
    "\n",
    include_str!("relief.wgsl")
);
pub const OVERVIEW_SHADER: &str = concat!(
    include_str!("appearance.wgsl"),
    "\n",
    include_str!("shadow.wgsl"),
    "\n",
    include_str!("overview.wgsl"),
    "\n",
    include_str!("relief.wgsl")
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
    fn gpu_shadows_and_relief_match_cpu() {
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
                "{}\n{}\n{}\n{}",
                APPEARANCE_SHADER,
                SHADOW_SHADER,
                RELIEF_SHADER,
                r#"
@group(0) @binding(0) var<uniform> p:Params;
@group(0) @binding(1) var<storage,read> heights:HeightTree;
@group(0) @binding(2) var<storage,read_write> result:array<vec4f>;
@compute @workgroup_size(64) fn check(@builtin(global_invocation_id) gid:vec3u) {
    let i=gid.x;let w=u32(p.bounds.z);if i>=w*u32(p.bounds.w){return;}
    let cell=vec2u(i%w,i/w);let y=maximum_height(0u,cell);
    let samples=array<vec2f,5>(vec2f(0.17,0.31),vec2f(0.55,0.8),vec2f(0.9,0.12),vec2f(0.25),vec2f(0.75));
    for(var n=0u;n<5u;n++){
        let lo=select(samples[n]-vec2f(0.03),vec2f(0),n==4u);
        let hi=select(samples[n]+vec2f(0.03),vec2f(1),n==4u);
        let edge=edge_relief(vec2f(cell),y,lo,hi);
        result[i*5u+n]=select(vec4f(ray_shadow(vec2f(cell)+samples[n],y),edge,0),vec4f(0),y< -900000.0);
    }
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
                    size: (w * h * 5 * 16) as u64,
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
                    0f32, 1., 17., 45., 89., 90., 135., 179., 180., 225., 270., 315., 330., 359.,
                    360.,
                ] {
                    for elevation in [15f32, 45., 60., 75.] {
                        let direction = surface_core::sun_direction(azimuth);
                        let slope = elevation.to_radians().tan();
                        let relief_width = if elevation == 15. {
                            0.1
                        } else if elevation == 45. {
                            0.25
                        } else {
                            0.5
                        };
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
                            1.,
                            relief_width,
                            0.,
                            0.,
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
                                    actual[(i * 5 + n) * 4],
                                    expected,
                                    "{kind}, azimuth={azimuth}, elevation={elevation}, cell={i}, sample={n}"
                                );
                                let (x, z) = (i % w, i / w);
                                let neighbor = |dx: isize, dz: isize| {
                                    let (nx, nz) = (x as isize + dx, z as isize + dz);
                                    if nx < 0 || nz < 0 || nx >= w as isize || nz >= h as isize {
                                        *y
                                    } else {
                                        values[nz as usize * w + nx as usize]
                                    }
                                };
                                let edge = if *y < -900000. {
                                    [0.; 2]
                                } else {
                                    surface_core::edge_relief_reference(
                                        *y,
                                        [
                                            neighbor(-1, 0),
                                            neighbor(1, 0),
                                            neighbor(0, -1),
                                            neighbor(0, 1),
                                        ],
                                        direction,
                                        if n == 4 {
                                            [0.; 2]
                                        } else {
                                            uv.map(|v| v - 0.03)
                                        },
                                        if n == 4 {
                                            [1.; 2]
                                        } else {
                                            uv.map(|v| v + 0.03)
                                        },
                                        relief_width,
                                    )
                                };
                                for (k, expected) in edge.iter().enumerate() {
                                    assert!(
                                        (actual[(i * 5 + n) * 4 + 1 + k] - expected).abs() < 1e-5,
                                        "relief {kind}, azimuth={azimuth}, width={relief_width}, cell={i}, sample={n}, channel={k}"
                                    );
                                }
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
