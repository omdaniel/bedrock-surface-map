use super::*;

fn setup() -> GpuLod {
    pollster::block_on(async {
        let instance = wgpu::Instance::default();
        let adapter = instance
            .request_adapter(&Default::default())
            .await
            .expect("native GPU required");
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor::default())
            .await
            .unwrap();
        let atlas = texture(
            &device,
            "synthetic checker atlas",
            32,
            32,
            1,
            3,
            wgpu::TextureFormat::Rgba8Unorm,
            wgpu::TextureUsages::COPY_DST
                | wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::STORAGE_BINDING,
        );
        let pixels: Vec<u8> = (0..1024)
            .flat_map(|i| {
                if i % 32 < 16 {
                    [204, 51, 26, 255]
                } else {
                    [26, 153, 204, 255]
                }
            })
            .collect();
        queue.write_texture(
            atlas.as_image_copy(),
            &pixels,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(128),
                rows_per_image: Some(32),
            },
            atlas.size(),
        );
        let materials = [0., 0., 1., 1., 0.5, 0.4, 0.5, 1., 0., 0., 0., 0.];
        let mut gpu = GpuLod::new(
            device,
            queue,
            wgpu::TextureFormat::Rgba8Unorm,
            &materials,
            atlas,
        )
        .unwrap();
        gpu.set_world([-128, -128, 256, 128], 512).unwrap();
        gpu.device
            .poll(wgpu::PollType::wait_indefinitely())
            .unwrap();
        gpu
    })
}
fn output(gpu: &GpuLod, w: u32, h: u32) -> wgpu::Texture {
    texture(
        &gpu.device,
        "LOD native render test",
        w,
        h,
        1,
        1,
        wgpu::TextureFormat::Rgba8Unorm,
        wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
    )
}
fn draw(gpu: &mut GpuLod, out: &wgpu::Texture, camera: [f64; 3], shadows: bool, relief: f32) {
    assert!(
        gpu.render(
            &out.create_view(&Default::default()),
            camera[0],
            camera[1],
            camera[2],
            out.width(),
            out.height(),
            false,
            shadows,
            45.,
            90.,
            0.55,
            false,
            relief,
            0.25
        )
        .unwrap()
    );
    gpu.device
        .poll(wgpu::PollType::wait_indefinitely())
        .unwrap();
}
fn detail(height: i16, covered: u32) -> Vec<u32> {
    (0..SAMPLES)
        .flat_map(|_| [height as i32 as u32, 0, 0xffffff, 0, 0, 0, 0, covered])
        .collect()
}
fn summary(rgb: [u16; 3], height: i16) -> Vec<u32> {
    (0..SAMPLES)
        .flat_map(|_| {
            [
                rgb[0] as u32 | ((rgb[1] as u32) << 16),
                rgb[2] as u32 | ((rgb[0] as u32) << 16),
                rgb[1] as u32 | ((rgb[2] as u32) << 16),
                height as u16 as u32 * 65537,
                height as u16 as u32 | (255 << 16),
                1 << 16,
            ]
        })
        .collect()
}
fn read(gpu: &GpuLod, source: &wgpu::Buffer) -> Vec<u8> {
    let readback = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size: source.size(),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = gpu.device.create_command_encoder(&Default::default());
    encoder.copy_buffer_to_buffer(source, 0, &readback, 0, source.size());
    gpu.queue.submit([encoder.finish()]);
    readback
        .slice(..)
        .map_async(wgpu::MapMode::Read, |r| r.unwrap());
    gpu.device
        .poll(wgpu::PollType::wait_indefinitely())
        .unwrap();
    readback.slice(..).get_mapped_range().unwrap().to_vec()
}
fn pixels(gpu: &GpuLod, image: &wgpu::Texture) -> Vec<u8> {
    let bytes_per_row = (image.width() * 4).div_ceil(256) * 256;
    let staging = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size: bytes_per_row as u64 * image.height() as u64,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let mut encoder = gpu.device.create_command_encoder(&Default::default());
    encoder.copy_texture_to_buffer(
        image.as_image_copy(),
        wgpu::TexelCopyBufferInfo {
            buffer: &staging,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(bytes_per_row),
                rows_per_image: Some(image.height()),
            },
        },
        image.size(),
    );
    gpu.queue.submit([encoder.finish()]);
    read(gpu, &staging)
}

#[test]
fn coarse_fine_coarse_and_retirement() {
    let mut gpu = setup();
    let out = output(&gpu, 128, 128);
    let coarse = Key::new(1, 0, 0).unwrap();
    let fine = Key::new(0, 0, 0).unwrap();
    let initial = gpu.gpu_bytes();
    assert_eq!(gpu.height_capacity(), 128);
    assert!(gpu.cpu_bytes() < 128 * 1024);
    gpu.add_tile(coarse, summary([13107, 26214, 39321], 0))
        .unwrap();
    gpu.add_tile(fine, detail(0, 1)).unwrap();
    assert_eq!(gpu.pending_tiles(), 2);
    assert!(!gpu.has_tile(coarse));
    draw(&mut gpu, &out, [64., 64., 0.5], false, 0.);
    assert!(gpu.has_tile(coarse));
    assert!(!gpu.has_tile(fine));
    assert_eq!(gpu.pending_tiles(), 1);
    gpu.set_cut(vec![CutEntry {
        key: coarse,
        opacity: 1.,
    }])
    .unwrap();
    draw(&mut gpu, &out, [64., 64., 0.5], false, 0.);
    let before = pixels(&gpu, &out);
    assert!((before[64 * 512 + 64 * 4] as i32 - 51).abs() <= 1);
    assert!((before[64 * 512 + 64 * 4 + 1] as i32 - 102).abs() <= 1);
    assert!(gpu.has_tile(fine));
    gpu.set_cut(vec![CutEntry {
        key: fine,
        opacity: 1.,
    }])
    .unwrap();
    draw(&mut gpu, &out, [64., 64., 32.], false, 0.);
    let actual = pixels(&gpu, &out);
    assert!(
        actual[64 * 512 + 4 * 4] > actual[64 * 512 + 24 * 4] + 100,
        "fine rendering must sample the real checker atlas"
    );
    let allocated = gpu.gpu_bytes();
    gpu.remove_tile(fine);
    assert_eq!(
        gpu.gpu_bytes(),
        allocated,
        "removed GPU bytes remain charged until completion"
    );
    assert!(gpu.retiring_bytes() >= gpu.tile_bytes(0));
    gpu.device
        .poll(wgpu::PollType::wait_indefinitely())
        .unwrap();
    assert_eq!(gpu.gpu_bytes(), allocated - gpu.tile_bytes(0));
    assert_eq!(gpu.retiring_bytes(), 0);
    gpu.set_cut(vec![CutEntry {
        key: coarse,
        opacity: 1.,
    }])
    .unwrap();
    draw(&mut gpu, &out, [64., 64., 0.5], false, 0.);
    assert_eq!(
        pixels(&gpu, &out),
        before,
        "coarse tile survives exact-cell eviction"
    );
    assert_eq!(gpu.gpu_bytes(), initial + gpu.tile_bytes(1) + 128 * 128 * 8);
}

#[test]
fn additive_unknown_does_not_reveal_parent() {
    let mut gpu = setup();
    let out = output(&gpu, 64, 64);
    let parent = Key::new(1, 0, 0).unwrap();
    let child = Key::new(0, 0, 0).unwrap();
    gpu.add_tile(parent, summary([65535, 0, 0], 0)).unwrap();
    gpu.add_tile(child, detail(0, 0)).unwrap();
    draw(&mut gpu, &out, [32., 32., 1.], false, 0.);
    draw(&mut gpu, &out, [32., 32., 1.], false, 0.);
    gpu.set_cut(vec![
        CutEntry {
            key: parent,
            opacity: 0.5,
        },
        CutEntry {
            key: child,
            opacity: 0.5,
        },
    ])
    .unwrap();
    draw(&mut gpu, &out, [32., 32., 1.], false, 0.);
    let color = pixels(&gpu, &out);
    let at = 32 * 256 + 32 * 4;
    assert!(
        color[at] > 130 && color[at] < 150,
        "parent must be weighted exactly once"
    );
    gpu.set_cut(vec![CutEntry {
        key: child,
        opacity: 1.,
    }])
    .unwrap();
    draw(&mut gpu, &out, [32., 32., 1.], false, 0.);
    assert!(
        pixels(&gpu, &out)[at] < 40,
        "unknown must not reveal parent ground"
    );
}

#[test]
fn gpu_height_hierarchy_and_exact_page_boundary_shadows() {
    let mut gpu = setup();
    let out = output(&gpu, 64, 64);
    let mut heights = vec![-3f32; 384 * 256];
    for z in 0..256usize {
        for x in 0..384usize {
            if x == 127 || x == 128 || x == 255 || x == 256 {
                heights[z * 384 + x] = 7.;
            }
            if z % 17 == 0 && x % 29 == 0 {
                heights[z * 384 + x] = -1e6;
            }
        }
    }
    gpu.set_world([-128, -128, 256, 128], 112).unwrap();
    for z in -1..1 {
        for x in -1..2 {
            let mut words = Vec::with_capacity(SAMPLES);
            for lz in 0..128 {
                for lx in 0..128 {
                    let h = heights
                        [((z + 1) * 128 + lz) as usize * 384 + ((x + 1) * 128 + lx) as usize];
                    words.push(if h < -900000. {
                        (2 << 16) | 32768
                    } else {
                        ((h * 16.) as i16 as u16 as u32) | (1 << 16)
                    });
                }
            }
            gpu.add_height(Key::new(0, x, z).unwrap(), words).unwrap();
            draw(&mut gpu, &out, [0., 0., 1.], false, 0.);
        }
    }
    let nodes = read(&gpu, &gpu.nodes);
    let nodes: &[u32] = bytemuck::cast_slice(&nodes);
    for slot in gpu.heights.values() {
        let root = slot * 21845 * 2 + 21844 * 2;
        assert_eq!((nodes[root + 1] as i32 >> 16) as f32 / 16., 7.);
    }
    let code = format!(
        "{}\n{}\n{}\n{}",
        crate::APPEARANCE_SHADER,
        include_str!("../lod_height.wgsl"),
        crate::RELIEF_SHADER,
        r#"
@group(0) @binding(0) var<uniform> p:Params;
@group(1) @binding(0) var<uniform> draw:Draw;
@group(1) @binding(1) var<storage,read> samples:array<vec4f>;
@group(1) @binding(2) var<storage,read_write> result:array<vec4f>;
@compute @workgroup_size(64) fn check(@builtin(global_invocation_id) id:vec3u) {
    if id.x>=arrayLength(&samples){return;}
    let s=samples[id.x];height_status=0u;
    let shade=ray_shadow(s.xy,s.z);
    let edge=edge_relief(floor(s.xy),s.z,fract(s.xy)-vec2f(0.03),fract(s.xy)+vec2f(0.03));
    result[id.x]=vec4f(shade,edge,f32(height_status));
}
"#
    );
    let pipeline = crate::compute_pipeline(
        &gpu.device,
        "exact page shadow boundary oracle",
        &code,
        "check",
    );
    let samples: Vec<[f32; 4]> = [
        -127.5, -1.75, -0.25, 0.25, 0.75, 1.25, 126.75, 127.75, 128.25, 129.75, 254.5,
    ]
    .into_iter()
    .flat_map(|x| {
        [-64.3, -0.7, 0.3, 50.8]
            .into_iter()
            .map(move |z| [x, z, heights_at(x, z), 0.])
    })
    .collect();
    let input = buffer(
        &gpu.device,
        "ray samples",
        bytemuck::cast_slice(&samples),
        wgpu::BufferUsages::STORAGE,
    );
    let result = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size: samples.len() as u64 * 16,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let draw_params = DrawUniform {
        origin: [0.; 4],
        key: [0, 0, 0, 0],
        world: [-128., -128., 256., 128.],
        edges: [0.; 4],
        corners: [0.; 4],
    };
    let draw_buffer = buffer(
        &gpu.device,
        "test page anchor",
        bytemuck::bytes_of(&draw_params),
        wgpu::BufferUsages::UNIFORM,
    );
    let group1 = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: None,
        layout: &pipeline.get_bind_group_layout(1),
        entries: &[entry(0, &draw_buffer), entry(1, &input), entry(2, &result)],
    });
    for azimuth in [0., 17., 45., 90., 135., 180., 225., 270., 315., 359.] {
        for elevation in [15f32, 45., 75.] {
            let direction = surface_core::sun_direction(azimuth);
            let params = [
                0.,
                0.,
                1.,
                64.,
                64.,
                0.,
                1.,
                elevation.to_radians().tan(),
                7.,
                0.,
                0.,
                0.,
                0.55,
                0.,
                direction[0],
                direction[1],
                1.,
                0.25,
                0.,
                0.,
            ];
            let uniform = buffer(
                &gpu.device,
                "test lighting",
                bytemuck::cast_slice(&params),
                wgpu::BufferUsages::UNIFORM,
            );
            let group0 = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: None,
                layout: &pipeline.get_bind_group_layout(0),
                entries: &[
                    entry(0, &uniform),
                    entry(4, &gpu.page_table),
                    entry(5, &gpu.nodes),
                ],
            });
            let mut encoder = gpu.device.create_command_encoder(&Default::default());
            {
                let mut pass = encoder.begin_compute_pass(&Default::default());
                pass.set_pipeline(&pipeline);
                pass.set_bind_group(0, &group0, &[]);
                pass.set_bind_group(1, &group1, &[]);
                pass.dispatch_workgroups(1, 1, 1);
            }
            gpu.queue.submit([encoder.finish()]);
            let actual = read(&gpu, &result);
            let actual: &[f32] = bytemuck::cast_slice(&actual);
            for (i, sample) in samples.iter().enumerate() {
                let at = [sample[0] + 128., sample[1] + 128.];
                let expected = surface_core::ray_shadow_reference(
                    &heights,
                    [384, 256],
                    at,
                    sample[2],
                    direction,
                    elevation.to_radians().tan(),
                );
                assert_eq!(
                    actual[i * 4],
                    expected,
                    "azimuth={azimuth}, elevation={elevation}, sample={sample:?}"
                );
                assert_eq!(
                    actual[i * 4 + 3],
                    0.,
                    "known complete page footprint must not report approximation"
                );
                let x = at[0].floor() as usize;
                let z = at[1].floor() as usize;
                let neighbor = |dx: isize, dz: isize| {
                    let nx = x as isize + dx;
                    let nz = z as isize + dz;
                    if nx < 0 || nz < 0 || nx >= 384 || nz >= 256 {
                        sample[2]
                    } else {
                        heights[nz as usize * 384 + nx as usize]
                    }
                };
                let uv = [sample[0].rem_euclid(1.), sample[1].rem_euclid(1.)];
                let edge = surface_core::edge_relief_reference(
                    sample[2],
                    [
                        neighbor(-1, 0),
                        neighbor(1, 0),
                        neighbor(0, -1),
                        neighbor(0, 1),
                    ],
                    direction,
                    uv.map(|v| v - 0.03),
                    uv.map(|v| v + 0.03),
                    0.25,
                );
                for k in 0..2 {
                    assert!(
                        (actual[i * 4 + 1 + k] - edge[k]).abs() < 0.00001,
                        "relief across page edge"
                    );
                }
            }
        }
    }
}
fn heights_at(x: f32, _z: f32) -> f32 {
    if [-1., 0., 127., 128.].contains(&x.floor()) {
        7.
    } else {
        -3.
    }
}

#[test]
fn coarse_lighting_is_cached_bounded_and_stitches_siblings() {
    let mut gpu = setup();
    let out = output(&gpu, 256, 128);
    gpu.set_world([0, 0, 512, 256], 0).unwrap();
    let left = Key::new(1, 0, 0).unwrap();
    let right = Key::new(1, 1, 0).unwrap();
    let mut red_blue = summary([65535, 0, 0], 0);
    for c in red_blue.chunks_exact_mut(6) {
        c[1] = 0;
        c[2] = 65535 << 16;
    }
    gpu.add_tile(left, red_blue).unwrap();
    gpu.add_tile(right, summary([0, 65535, 0], 0)).unwrap();
    draw(&mut gpu, &out, [256., 128., 1.], false, 0.);
    draw(&mut gpu, &out, [256., 128., 1.], false, 0.);
    gpu.set_cut(vec![
        CutEntry {
            key: left,
            opacity: 1.,
        },
        CutEntry {
            key: right,
            opacity: 1.,
        },
    ])
    .unwrap();
    assert_eq!(gpu.pending_preparations(), 0);
    let render_vivid = |gpu: &mut GpuLod| {
        assert!(
            gpu.render(
                &out.create_view(&Default::default()),
                256.,
                128.,
                1.,
                256,
                128,
                false,
                false,
                45.,
                90.,
                0.55,
                true,
                0.,
                0.25
            )
            .unwrap()
        );
        gpu.device
            .poll(wgpu::PollType::wait_indefinitely())
            .unwrap();
    };
    render_vivid(&mut gpu);
    assert_eq!(
        gpu.height_status()[0],
        8,
        "a stale lighting cache is not exact current feedback"
    );
    assert_eq!(
        gpu.pending_preparations(),
        1,
        "only one of two caches may be rebuilt in one frame"
    );
    render_vivid(&mut gpu);
    assert_eq!(gpu.pending_preparations(), 0);
    assert_eq!(gpu.height_status()[0], 0);
    let frame = pixels(&gpu, &out);
    let at = 64 * 1024;
    assert!(frame[at + 120 * 4 + 2] > 250);
    assert!(frame[at + 136 * 4 + 1] > 250);
    assert!(
        frame[at + 127 * 4 + 1] > 0 && frame[at + 127 * 4 + 2] > 0,
        "one-pixel sibling gutter must filter both sides of the boundary"
    );
    gpu.remove_tile(right);
    gpu.device
        .poll(wgpu::PollType::wait_indefinitely())
        .unwrap();
    render_vivid(&mut gpu);
    let frame = pixels(&gpu, &out);
    assert!(
        frame[at + 127 * 4 + 2] > 250 && frame[at + 127 * 4 + 1] == 0,
        "eviction must restore the surviving tile's own gutter"
    );
}

#[test]
fn height_approximation_preserves_ground_and_coarse_max_is_only_pruning() {
    let mut gpu = setup();
    let out = output(&gpu, 64, 64);
    let key = Key::new(1, 0, 0).unwrap();
    gpu.set_world([0, 0, 256, 256], 320).unwrap();
    gpu.add_tile(key, summary([13107, 26214, 39321], 0))
        .unwrap();
    draw(&mut gpu, &out, [128., 128., 1.], true, 0.);
    assert_eq!(
        gpu.height_status()[0],
        1,
        "missing resident pages have distinct status"
    );
    gpu.set_cut(vec![CutEntry { key, opacity: 1. }]).unwrap();
    draw(&mut gpu, &out, [128., 128., 1.], true, 0.);
    assert_eq!(
        gpu.height_status()[0],
        1,
        "cached approximate status survives ordinary coarse draws"
    );
    let incomplete = pixels(&gpu, &out);
    assert!(
        (incomplete[32 * 256 + 32 * 4] as i32 - 51).abs() <= 1,
        "missing height must not erase known ground"
    );
    let unknown: Vec<u32> = (0..SAMPLES)
        .flat_map(|_| [4 << 16, 32768 * 65537])
        .collect();
    gpu.add_height(key, unknown).unwrap();
    assert!(!gpu.height_status_ready() || gpu.height_status()[0] != 0);
    draw(&mut gpu, &out, [128., 128., 1.], true, 0.);
    assert_eq!(
        gpu.pending_preparations(),
        1,
        "height build and relighting occupy separate frames"
    );
    assert_eq!(
        gpu.height_status()[0],
        1 | 8,
        "old cache keeps its warning until the latest shade is ready"
    );
    draw(&mut gpu, &out, [128., 128., 1.], true, 0.);
    assert_eq!(
        gpu.height_status()[0],
        2,
        "dataset unknown is not a missing resident page"
    );
    let heights: Vec<u32> = (0..SAMPLES).flat_map(|_| [1 << 16, 320 << 16]).collect();
    gpu.add_height(key, heights).unwrap();
    draw(&mut gpu, &out, [128., 128., 1.], true, 0.);
    draw(&mut gpu, &out, [128., 128., 1.], true, 0.);
    assert_eq!(gpu.height_status()[0], 0);
    assert_eq!(
        pixels(&gpu, &out),
        incomplete,
        "coarse leaves with mean=0,max=20 must not cast max-height shadows onto their flat representative surface"
    );
    gpu.remove_height(key);
    gpu.device
        .poll(wgpu::PollType::wait_indefinitely())
        .unwrap();
    gpu.set_world([0, 0, 256, 256], 0).unwrap();
    draw(&mut gpu, &out, [128., 128., 1.], true, 0.);
    assert_eq!(
        gpu.height_status()[0],
        0,
        "ray above dataset maximum needs no height-page dependency"
    );
}

#[test]
fn sparse_ancestor_absence_is_not_missing_or_approximate_ground() {
    let mut gpu = setup();
    let out = output(&gpu, 64, 64);
    for (x, z, level) in [(-1, -3, 1), (65534, -65535, 3), (-1, 0, 16)] {
        let key = Key::new(0, x, z).unwrap();
        let parent = Key::new(level, x >> level, z >> level).unwrap();
        let origin = [x * 128, z * 128];
        let camera = [origin[0] as f64 + 64., origin[1] as f64 + 64., 1.];
        gpu.set_world(
            [origin[0], origin[1], origin[0] + 128, origin[1] + 128],
            320,
        )
        .unwrap();
        gpu.set_cut(Vec::new()).unwrap();
        gpu.add_tile(key, detail(0, 1)).unwrap();
        draw(&mut gpu, &out, camera, false, 0.);
        gpu.set_cut(unit_cut([key])).unwrap();
        for (flags, status) in [(4, 2), (2, 0), (6, 2), (1, 1), (5, 1)] {
            let words = (0..SAMPLES)
                .flat_map(|_| [flags << 16, 320 << 16])
                .collect();
            gpu.add_height(parent, words).unwrap();
            draw(&mut gpu, &out, camera, true, 0.5);
            assert_eq!(
                gpu.height_status()[0],
                status,
                "L{level} ancestor flags {flags}: only certified absence may cover unavailable fine heights"
            );
        }
        let local_x = ((x - (parent.x << level)) * 128) >> level;
        let local_z = ((z - (parent.z << level)) * 128) >> level;
        let side = (128 >> level).max(1);
        let mixed = (0..SAMPLES)
            .flat_map(|i| {
                let sx = (i % 128) as i32;
                let sz = (i / 128) as i32;
                let absent = (local_x..local_x + side).contains(&sx)
                    && (local_z..local_z + side).contains(&sz);
                [if absent { 4 << 16 } else { 1 << 16 }, 320 << 16]
            })
            .collect();
        gpu.add_height(parent, mixed).unwrap();
        draw(&mut gpu, &out, camera, true, 0.5);
        assert_eq!(
            gpu.height_status()[0],
            2,
            "L{level} lookup selects the covering ancestor cell/mip, not unrelated known ground"
        );
        gpu.add_height(key, vec![(2 << 16) | 32768; SAMPLES])
            .unwrap();
        draw(&mut gpu, &out, camera, true, 0.5);
        assert_eq!(gpu.height_status()[0], 0, "exact pages take precedence");
        gpu.set_cut(Vec::new()).unwrap();
        gpu.remove_tile(key);
        gpu.remove_height(key);
        gpu.remove_height(parent);
        gpu.device
            .poll(wgpu::PollType::wait_indefinitely())
            .unwrap();
    }
}

#[test]
fn distant_fine_camera_and_material_range_upload() {
    let mut gpu = setup();
    let out = output(&gpu, 64, 64);
    let x = 16_000_000;
    let key = Key::new(0, x, -x).unwrap();
    let origin = x * 128;
    gpu.set_world([origin, -origin, origin + 128, -origin + 128], 0)
        .unwrap();
    gpu.add_tile(key, detail(0, 1)).unwrap();
    draw(
        &mut gpu,
        &out,
        [origin as f64 + 64., -origin as f64 + 64., 32.],
        false,
        0.,
    );
    gpu.set_cut(vec![CutEntry { key, opacity: 1. }]).unwrap();
    draw(
        &mut gpu,
        &out,
        [origin as f64 + 64., -origin as f64 + 64., 32.],
        false,
        0.,
    );
    let image = pixels(&gpu, &out);
    assert!(
        image[32 * 256 + 4 * 4] > image[32 * 256 + 24 * 4] + 100,
        "fine texture coordinates retain precision at distant world origins"
    );
    assert_eq!(gpu.resize_bytes(64, 64), 0);
    assert_eq!(gpu.resize_bytes(128, 64), 128 * 64 * 8);
    assert!(gpu.update_materials(1, &[0.; 12]).is_err());
    let material = [0., 0., 1., 1., 0.1, 0.8, 0.2, 1., 0., 0., 0., 0.];
    let before = gpu.gpu_bytes();
    gpu.update_materials(0, &material).unwrap();
    assert_eq!(
        gpu.gpu_bytes(),
        before + 48,
        "only one material range upload is allocated"
    );
    gpu.device
        .poll(wgpu::PollType::wait_indefinitely())
        .unwrap();
    assert_eq!(gpu.gpu_bytes(), before);
}

#[test]
fn latest_lighting_only_prepares_visible_cut_and_keeps_offcut_fallbacks() {
    let mut gpu = setup();
    let out = output(&gpu, 128, 128);
    let keys = [
        Key::new(1, 0, 0).unwrap(),
        Key::new(1, 1, 0).unwrap(),
        Key::new(1, 4, 0).unwrap(),
    ];
    gpu.set_world([0, 0, 1280, 256], 0).unwrap();
    for key in keys {
        gpu.add_tile(key, summary([13107, 26214, 39321], 0))
            .unwrap();
        draw(&mut gpu, &out, [128., 128., 1.], false, 0.);
    }
    gpu.set_cut(
        keys.into_iter()
            .map(|key| CutEntry { key, opacity: 1. })
            .collect(),
    )
    .unwrap();
    let first_epoch = gpu.lighting_epoch();
    draw(&mut gpu, &out, [128., 128., 1.], false, 0.5);
    let second_epoch = gpu.lighting_epoch();
    assert_eq!(second_epoch, first_epoch + 1);
    assert_eq!(gpu.tile_lighting_epoch(keys[0]), second_epoch);
    assert_eq!(gpu.tile_lighting_epoch(keys[1]), first_epoch);
    assert_eq!(
        gpu.pending_preparations(),
        0,
        "offscreen dirty cut members must not sustain RAF"
    );
    draw(&mut gpu, &out, [128., 128., 1.], false, 0.75);
    let latest = gpu.lighting_epoch();
    gpu.set_cut(vec![CutEntry {
        key: keys[1],
        opacity: 1.,
    }])
    .unwrap();
    assert!(
        !gpu.height_status_ready(),
        "cut mutation invalidates completed feedback"
    );
    draw(&mut gpu, &out, [384., 128., 1.], false, 0.75);
    assert_eq!(
        gpu.tile_lighting_epoch(keys[1]),
        latest,
        "skip every obsolete lighting revision"
    );
    assert_eq!(
        gpu.tile_lighting_epoch(keys[2]),
        first_epoch,
        "offcut fallback remains resident without preparation"
    );
    assert!(gpu.has_tile(keys[2]));
    assert_eq!(gpu.pending_preparations(), 0);
    gpu.remove_tile(keys[0]);
    gpu.remove_height(Key::new(1, 0, 0).unwrap());
    assert_eq!(gpu.pending_preparations(), 0);
}

#[test]
fn allocation_queries_height_admission_and_explicit_disposal() {
    let mut gpu = setup();
    let out = output(&gpu, 64, 64);
    let key = Key::new(0, 0, 0).unwrap();
    assert_eq!(gpu.available_height_slots(), 127);
    assert!(
        !gpu.height_status_ready(),
        "no readback yet is not an exact result"
    );
    gpu.add_height(key, vec![1 << 16; SAMPLES]).unwrap();
    assert_eq!(gpu.available_height_slots(), 126);
    draw(&mut gpu, &out, [64., 64., 1.], false, 0.);
    assert_eq!(gpu.available_height_slots(), 126);
    gpu.add_height(key, vec![1 << 16; SAMPLES]).unwrap();
    assert_eq!(
        gpu.available_height_slots(),
        125,
        "pending replacement reserves a second slot"
    );
    draw(&mut gpu, &out, [64., 64., 1.], false, 0.);
    assert_eq!(gpu.available_height_slots(), 126);
    gpu.remove_height(key);
    assert_eq!(
        gpu.available_height_slots(),
        126,
        "retired slots are not immediately reusable"
    );
    assert_eq!(gpu.retiring_height_slots(), 1);
    let retiring = gpu.retiring_bytes();
    assert_eq!(
        retiring,
        TABLE_ENTRIES as u64 * 16,
        "arena slot retirement adds no allocation charge"
    );
    gpu.device
        .poll(wgpu::PollType::wait_indefinitely())
        .unwrap();
    assert_eq!(
        gpu.available_height_slots(),
        127,
        "read-only query reaps completed slots"
    );
    gpu.add_tile(key, detail(0, 1)).unwrap();
    draw(&mut gpu, &out, [64., 64., 1.], false, 0.);
    let a = gpu.allocation_bytes();
    assert_eq!(a[0], a[1..].iter().sum::<u64>());
    assert_eq!(a[0], gpu.gpu_bytes());
    assert_eq!(a[2], gpu.tile_bytes(0));
    assert_eq!(a[3], 128 * HEIGHT_PAGE_BYTES);
    assert_eq!(a[4], 64 * 64 * 8);
    assert_eq!(texture_bytes(&gpu.atlas), (32 * 32 + 16 * 16 + 8 * 8) * 4);
    let old_total = gpu.gpu_bytes();
    gpu.resize(128, 64).unwrap();
    assert_eq!(gpu.gpu_bytes(), old_total + gpu.resize_bytes(64, 128));
    assert_eq!(gpu.retiring_bytes(), 64 * 64 * 8);
    gpu.remove_tile(key);
    gpu.add_tile(key, detail(0, 1)).unwrap();
    assert!(gpu.cpu_bytes() > SAMPLES * 32);
    gpu.dispose();
    assert_eq!(gpu.allocation_bytes(), [0; 6]);
    assert_eq!(gpu.retiring_bytes(), 0);
    assert_eq!(gpu.pending_preparations(), 0);
    assert_eq!(gpu.pending_submissions(), 0);
    assert_eq!(gpu.available_height_slots(), 0);
    assert!(gpu.cpu_bytes() < 8192);
    assert!(!gpu.height_status_ready());
    assert!(gpu.add_height(key, vec![1 << 16; SAMPLES]).is_err());
    gpu.dispose();
    gpu.device
        .poll(wgpu::PollType::wait_indefinitely())
        .unwrap();
    assert_eq!(gpu.gpu_bytes(), 0);
}

#[test]
fn cached_gutter_status_copies_and_clears_without_recursive_contamination() {
    let mut gpu = setup();
    let out = output(&gpu, 64, 64);
    let left = Key::new(1, 0, 0).unwrap();
    let right = Key::new(1, 1, 0).unwrap();
    for key in [left, right] {
        gpu.add_tile(key, summary([65535, 0, 0], 0)).unwrap();
        draw(&mut gpu, &out, [128., 128., 1.], false, 0.);
    }
    gpu.queue.write_buffer(
        gpu.tiles[&right].cached_status.as_ref().unwrap(),
        0,
        bytemuck::bytes_of(&2u32),
    );
    let mut encoder = gpu.device.create_command_encoder(&Default::default());
    gpu.stitch_lit_gutters(left, &mut encoder);
    gpu.submit(encoder);
    let bytes = read(&gpu, gpu.tiles[&left].cached_status.as_ref().unwrap());
    let flags: &[u32] = bytemuck::cast_slice(&bytes);
    assert_eq!(flags[0], 0);
    assert_eq!(flags[gutter_status_offset(1, 0) as usize / 4], 2);
    let bytes = read(&gpu, gpu.tiles[&right].cached_status.as_ref().unwrap());
    let flags: &[u32] = bytemuck::cast_slice(&bytes);
    assert_eq!(flags[gutter_status_offset(-1, 0) as usize / 4], 0);
    gpu.set_cut(vec![CutEntry {
        key: left,
        opacity: 1.,
    }])
    .unwrap();
    draw(&mut gpu, &out, [128., 128., 1.], false, 0.);
    assert_eq!(
        gpu.height_status()[0],
        2,
        "offcut sibling border must not claim exact height evidence"
    );
    gpu.remove_tile(right);
    draw(&mut gpu, &out, [128., 128., 1.], false, 0.);
    assert_eq!(
        gpu.height_status()[0],
        0,
        "eviction restores own border and clears only neighbor status"
    );
}

#[test]
fn fine_four_page_corners_are_translation_invariant() {
    let mut gpu = setup();
    let out = output(&gpu, 96, 96);
    let mut reference = None;
    for tile_origin in [0, -100_000, 16_000_000] {
        let old: Vec<_> = gpu.tiles.keys().copied().collect();
        for key in old {
            gpu.remove_tile(key);
            gpu.remove_height(key);
        }
        gpu.device
            .poll(wgpu::PollType::wait_indefinitely())
            .unwrap();
        let origin = tile_origin * 128;
        gpu.set_world(
            [origin - 128, -origin - 128, origin + 128, -origin + 128],
            160,
        )
        .unwrap();
        let mut cut = Vec::new();
        for dz in -1..=0 {
            for dx in -1..=0 {
                let key = Key::new(0, tile_origin + dx, -tile_origin + dz).unwrap();
                let mut cells = detail(0, 1);
                let mut heights = vec![1u32 << 16; SAMPLES];
                for z in 0..128 {
                    for x in 0..128 {
                        let wall = dx == 0 && x < 2;
                        let h = if wall { 160 } else { 0 };
                        cells[(z * 128 + x) * 8] = h;
                        cells[(z * 128 + x) * 8 + 2] = if dz < 0 { 0xffc080 } else { 0x80c0ff };
                        heights[z * 128 + x] |= h;
                    }
                }
                gpu.add_tile(key, cells).unwrap();
                draw(
                    &mut gpu,
                    &out,
                    [origin as f64 + 0.125, -origin as f64 - 0.25, 8.],
                    true,
                    0.5,
                );
                gpu.add_height(key, heights).unwrap();
                draw(
                    &mut gpu,
                    &out,
                    [origin as f64 + 0.125, -origin as f64 - 0.25, 8.],
                    true,
                    0.5,
                );
                cut.push(CutEntry { key, opacity: 1. });
            }
        }
        gpu.set_cut(cut).unwrap();
        draw(
            &mut gpu,
            &out,
            [origin as f64 + 0.125, -origin as f64 - 0.25, 8.],
            true,
            0.5,
        );
        assert_eq!(gpu.height_status()[0], 0);
        let actual = pixels(&gpu, &out);
        if let Some(expected) = &reference {
            assert_eq!(
                &actual, expected,
                "per-draw coordinates must agree at all four translated page corners"
            );
        } else {
            reference = Some(actual);
        }
    }
}

#[test]
fn mixed_cut_adjacency_uses_integer_parent_keys_and_opacity() {
    for level in [0, 3, 15] {
        for p in [-1_000_000, -1, 0, 1_000_000] {
            let parent = Key::new(level + 1, p, -p).unwrap();
            for (child, neighbor, edge) in [
                ((2 * p, -2 * p), (p - 1, -p), 0),
                ((2 * p + 1, -2 * p), (p + 1, -p), 1),
                ((2 * p, -2 * p), (p, -p - 1), 2),
                ((2 * p, -2 * p + 1), (p, -p + 1), 3),
                ((2 * p, -2 * p), (p - 1, -p - 1), 4),
                ((2 * p + 1, -2 * p), (p + 1, -p - 1), 5),
                ((2 * p, -2 * p + 1), (p - 1, -p + 1), 6),
                ((2 * p + 1, -2 * p + 1), (p + 1, -p + 1), 7),
            ] {
                let child = Key::new(level, child.0, child.1).unwrap();
                let neighbor = Key::new(level + 1, neighbor.0, neighbor.1).unwrap();
                assert_eq!(child.parent(), parent);
                assert_eq!(adjacent_edge(child, neighbor), Some(edge));
                assert_eq!(
                    adjacent_edge(child, parent),
                    None,
                    "overlapping temporal parent is not a spatial neighbor"
                );
                let cut = [
                    CutEntry {
                        key: child,
                        opacity: 1.,
                    },
                    CutEntry {
                        key: neighbor,
                        opacity: 0.25,
                    },
                ];
                let boundaries = cut_boundaries(&cut);
                let mut weights = [0.; 8];
                weights[edge] = 0.25;
                assert_eq!(boundaries[&child].weights, weights);
                let mut hidden = cut;
                hidden[1].opacity = 0.;
                assert!(cut_boundaries(&hidden).is_empty());
            }
        }
    }
}

#[test]
fn mixed_boundary_matches_parent_and_preserves_interior_at_large_origins() {
    let mut gpu = setup();
    let out = output(&gpu, 256, 64);
    for level in [0, 3] {
        let mut reference = None;
        for p in [0, -2_000, if level == 0 { 8_000_000 } else { 900_000 }] {
            gpu.set_cut(vec![]).unwrap();
            for key in gpu.tiles.keys().copied().collect::<Vec<_>>() {
                gpu.remove_tile(key);
            }
            gpu.device
                .poll(wgpu::PollType::wait_indefinitely())
                .unwrap();
            let parent = Key::new(level + 1, p, -p).unwrap();
            let child = Key::new(level, p * 2 + 1, -p * 2).unwrap();
            let neighbor = Key::new(level + 1, p + 1, -p).unwrap();
            let ox = p as f64 * parent.span();
            let oz = -p as f64 * parent.span();
            let sample = (1u32 << level) as f64;
            let camera = [ox + parent.span(), oz + 64. * sample, 32. / sample];
            gpu.set_world(
                [
                    ox as i32,
                    oz as i32,
                    (ox + parent.span() * 2.) as i32,
                    (oz + parent.span()) as i32,
                ],
                0,
            )
            .unwrap();
            for (key, words) in [
                (parent, summary([0, 65535, 0], 0)),
                (neighbor, summary([65535, 0, 0], 0)),
                (
                    child,
                    if level == 0 {
                        detail(0, 1)
                    } else {
                        summary([0, 0, 65535], 0)
                    },
                ),
            ] {
                gpu.add_tile(key, words).unwrap();
                draw(&mut gpu, &out, camera, false, 0.);
            }
            gpu.set_cut(vec![CutEntry {
                key: child,
                opacity: 1.,
            }])
            .unwrap();
            draw(&mut gpu, &out, camera, false, 0.);
            let exact = pixels(&gpu, &out);
            gpu.set_cut(vec![
                CutEntry {
                    key: parent,
                    opacity: 1.,
                },
                CutEntry {
                    key: neighbor,
                    opacity: 1.,
                },
            ])
            .unwrap();
            draw(&mut gpu, &out, camera, false, 0.);
            let coarse = pixels(&gpu, &out);
            gpu.set_cut(vec![
                CutEntry {
                    key: child,
                    opacity: 1.,
                },
                CutEntry {
                    key: neighbor,
                    opacity: 1.,
                },
            ])
            .unwrap();
            draw(&mut gpu, &out, camera, false, 0.);
            let mixed = pixels(&gpu, &out);
            assert_eq!(gpu.height_status()[0], 0);
            assert_eq!(gpu.pending_preparations(), 0);
            for y in 0..64 {
                for x in 0..64 {
                    let at = (y * 256 + x) * 4;
                    assert_eq!(
                        &mixed[at..at + 4],
                        &exact[at..at + 4],
                        "interior must remain exact at level {level}"
                    );
                }
                for x in 126..130 {
                    let at = (y * 256 + x) * 4;
                    for c in 0..3 {
                        assert!(
                            (mixed[at + c] as i32 - coarse[at + c] as i32).abs() <= 1,
                            "common parent edge mismatch at level {level}, x={x}"
                        );
                    }
                }
            }
            assert!(
                mixed
                    .chunks_exact(4)
                    .all(|p| p[3] == 255 && p[..3].iter().map(|c| *c as u32).sum::<u32>() > 50),
                "mixed cut must have no blank strip"
            );
            assert_ne!(
                &mixed[100 * 4..104 * 4],
                &exact[100 * 4..104 * 4],
                "band must actually blend rather than only meet at a line"
            );
            if let Some(expected) = &reference {
                assert_eq!(&mixed, expected, "mixed edge is translation invariant");
            } else {
                reference = Some(mixed);
            }
        }
    }
}

#[test]
fn mixed_edge_parent_lighting_is_bounded_visible_and_latest() {
    let mut gpu = setup();
    let out = output(&gpu, 64, 64);
    let parent = Key::new(1, 0, 0).unwrap();
    let neighbor = Key::new(1, 1, 0).unwrap();
    let child = Key::new(0, 1, 0).unwrap();
    gpu.set_world([0, 0, 512, 256], 0).unwrap();
    for key in [parent, neighbor, child, Key::new(0, 2, 0).unwrap()] {
        let words = if key.level == 0 {
            vec![1 << 16; SAMPLES]
        } else {
            (0..SAMPLES).flat_map(|_| [1 << 16, 0]).collect()
        };
        gpu.add_height(key, words).unwrap();
        draw(&mut gpu, &out, [192., 64., 16.], false, 0.);
    }
    for (key, words) in [
        (parent, summary([0, 65535, 0], 0)),
        (neighbor, summary([65535, 0, 0], 0)),
        (child, detail(0, 1)),
    ] {
        gpu.add_tile(key, words).unwrap();
        draw(&mut gpu, &out, [192., 64., 16.], false, 0.);
    }
    gpu.set_cut(vec![
        CutEntry {
            key: child,
            opacity: 1.,
        },
        CutEntry {
            key: neighbor,
            opacity: 1.,
        },
    ])
    .unwrap();
    let initial = gpu.lighting_epoch();
    draw(&mut gpu, &out, [192., 64., 16.], false, 0.5);
    assert_eq!(
        gpu.pending_preparations(),
        0,
        "interior-only view does not relight offscreen parent edges"
    );
    assert_eq!(gpu.tile_lighting_epoch(parent), initial);
    draw(&mut gpu, &out, [255., 64., 64.], false, 0.75);
    let latest = gpu.lighting_epoch();
    assert_eq!(
        gpu.tile_lighting_epoch(parent),
        latest,
        "visible edge needs its off-cut parent cache"
    );
    assert_eq!(
        gpu.tile_lighting_epoch(neighbor),
        initial,
        "one cache preparation per frame"
    );
    assert_eq!(
        gpu.pending_preparations(),
        1,
        "offscreen neighbor gutter is also a visible edge dependency"
    );
    assert_eq!(gpu.height_status()[0], 8);
    draw(&mut gpu, &out, [255., 64., 64.], false, 0.75);
    assert_eq!(gpu.tile_lighting_epoch(neighbor), latest);
    assert_eq!(gpu.pending_preparations(), 0);
    assert_eq!(gpu.height_status()[0], 0);
    gpu.remove_tile(parent);
    assert!(
        gpu.render(
            &out.create_view(&Default::default()),
            255.,
            64.,
            64.,
            64,
            64,
            false,
            false,
            45.,
            90.,
            0.55,
            false,
            0.75,
            0.25
        )
        .is_err(),
        "missing required parent must not sample a blank dummy texture"
    );
}

#[test]
fn mixed_edge_never_reveals_parent_through_child_coverage() {
    let mut gpu = setup();
    let out = output(&gpu, 64, 64);
    gpu.set_world([0, 0, 512, 256], 0).unwrap();
    let parent = Key::new(1, 0, 0).unwrap();
    let neighbor = Key::new(1, 1, 0).unwrap();
    let child = Key::new(0, 1, 0).unwrap();
    for key in [parent, neighbor] {
        gpu.add_tile(key, summary([65535, 0, 0], 0)).unwrap();
        draw(&mut gpu, &out, [255., 64., 64.], false, 0.);
    }
    for coverage in [0, 2, 3] {
        gpu.add_tile(child, detail(0, coverage)).unwrap();
        draw(&mut gpu, &out, [255., 64., 64.], false, 0.);
        gpu.set_cut(vec![CutEntry {
            key: child,
            opacity: 1.,
        }])
        .unwrap();
        draw(&mut gpu, &out, [255., 64., 64.], false, 0.);
        let before = pixels(&gpu, &out);
        gpu.set_cut(vec![
            CutEntry {
                key: child,
                opacity: 1.,
            },
            CutEntry {
                key: neighbor,
                opacity: 1.,
            },
        ])
        .unwrap();
        draw(&mut gpu, &out, [255., 64., 64.], false, 0.);
        assert_eq!(
            pixels(&gpu, &out),
            before,
            "coverage {coverage} may not acquire parent ground in the blend band"
        );
    }
}

#[test]
fn diagonal_mixed_corner_uses_common_parent_gutters_and_visible_dependencies() {
    let mut gpu = setup();
    let out = output(&gpu, 128, 128);
    let mut reference = None;
    for p in [0, -1_000, 8_000_000] {
        gpu.set_cut(vec![]).unwrap();
        for key in gpu.tiles.keys().copied().collect::<Vec<_>>() {
            gpu.remove_tile(key);
        }
        gpu.device
            .poll(wgpu::PollType::wait_indefinitely())
            .unwrap();
        let ox = p as f64 * 256.;
        let oz = -ox;
        let bounds = [
            (ox - 256.) as i32,
            (oz - 256.) as i32,
            (ox + 256.) as i32,
            (oz + 256.) as i32,
        ];
        gpu.set_world(bounds, 0).unwrap();
        let camera = [ox, oz, 64.];
        let parents = [(-1, -1), (0, -1), (-1, 0), (0, 0)]
            .map(|(dx, dz)| Key::new(1, p + dx, -p + dz).unwrap());
        let colors = [
            [0, 65535, 0],
            [65535, 0, 0],
            [0, 0, 65535],
            [65535, 65535, 0],
        ];
        for (key, color) in parents.into_iter().zip(colors) {
            gpu.add_tile(key, summary(color, 0)).unwrap();
            draw(&mut gpu, &out, camera, false, 0.);
        }
        let children = [(-1, -1), (0, -1), (-1, 0)]
            .map(|(dx, dz)| Key::new(0, p * 2 + dx, -p * 2 + dz).unwrap());
        for key in children {
            gpu.add_tile(key, detail(0, 1)).unwrap();
            draw(&mut gpu, &out, camera, false, 0.);
        }
        let fine_cut: Vec<_> = children
            .into_iter()
            .map(|key| CutEntry { key, opacity: 1. })
            .collect();
        gpu.set_cut(fine_cut.clone()).unwrap();
        draw(&mut gpu, &out, camera, false, 0.);
        let exact = pixels(&gpu, &out);
        gpu.set_cut(
            parents
                .into_iter()
                .map(|key| CutEntry { key, opacity: 1. })
                .collect(),
        )
        .unwrap();
        draw(&mut gpu, &out, camera, false, 0.);
        let coarse = pixels(&gpu, &out);
        let mut mixed_cut = fine_cut;
        mixed_cut.push(CutEntry {
            key: parents[3],
            opacity: 1.,
        });
        gpu.set_cut(mixed_cut).unwrap();
        assert_eq!(
            gpu.cuts[0].boundaries[&children[0]].weights[7], 1.,
            "diagonal-only child needs a corner patch"
        );
        draw(&mut gpu, &out, camera, false, 0.);
        let mixed = pixels(&gpu, &out);
        let band = |d: f64| {
            let t = (d / 2.).clamp(0., 1.);
            1. - t * t * (3. - 2. * t)
        };
        for y in 0..128 {
            for x in 0..128 {
                let weight = match (x < 64, y < 64) {
                    (true, true) => band((63.5 - x as f64) / 64.) * band((63.5 - y as f64) / 64.),
                    (true, false) => band((63.5 - x as f64) / 64.),
                    (false, true) => band((63.5 - y as f64) / 64.),
                    _ => 1.,
                };
                let at = (y * 128 + x) * 4;
                for c in 0..3 {
                    let expected =
                        exact[at + c] as f64 * (1. - weight) + coarse[at + c] as f64 * weight;
                    assert!(
                        (mixed[at + c] as f64 - expected).abs() <= 2.,
                        "corner blend mismatch x={x},y={y},channel={c}"
                    );
                }
                assert_eq!(mixed[at + 3], 255);
            }
        }
        if let Some(expected) = &reference {
            assert_eq!(&mixed, expected);
        } else {
            reference = Some(mixed);
        }
        gpu.set_world(bounds, 16).unwrap();
        let corner_view = [ox - 0.75, oz - 0.75, 256.];
        draw(&mut gpu, &out, corner_view, false, 0.);
        assert_eq!(
            gpu.pending_preparations(),
            3,
            "only NW child is onscreen but all four sampled parent/gutter sources need fresh lighting"
        );
        for _ in 0..3 {
            draw(&mut gpu, &out, corner_view, false, 0.);
        }
        assert_eq!(gpu.pending_preparations(), 0);
        assert_eq!(gpu.height_status()[0], 0);
    }
}

fn unit_cut(keys: impl IntoIterator<Item = Key>) -> Vec<CutEntry> {
    keys.into_iter()
        .map(|key| CutEntry { key, opacity: 1. })
        .collect()
}

#[test]
fn transition_topology_rejects_overlap_and_unbalanced_edges_and_corners() {
    for origin in [0, -1000, 8_000_000] {
        let coarse = Key::new(2, origin, -origin).unwrap();
        for (dx, dz) in [(-1, 0), (-1, -1), (4, 4), (4, 0)] {
            let fine = Key::new(0, origin * 4 + dx, -origin * 4 + dz).unwrap();
            let entries = unit_cut([coarse, fine]);
            assert!(Topology::new(entries.clone(), true).is_err());
            assert!(
                Topology::new(entries, false).is_err(),
                "stable cuts also reject unsupported level jumps"
            );
        }
        let child = Key::new(1, origin * 2, -origin * 2).unwrap();
        assert!(Topology::new(unit_cut([coarse, child]), true).is_err());
        let separated = Key::new(0, origin * 4 - 2, -origin * 4 - 2).unwrap();
        assert!(Topology::new(unit_cut([coarse, separated]), true).is_ok());
    }
    let key = Key::new(0, 0, 0).unwrap();
    assert!(Topology::new(unit_cut([key, key]), true).is_err());
    for opacity in [0., 0.5, f32::NAN, f32::INFINITY] {
        assert!(Topology::new(vec![CutEntry { key, opacity }], true).is_err());
    }
}

fn draw_transition_fixture(gpu: &mut GpuLod, out: &wgpu::Texture, camera: [f64; 3]) {
    assert!(
        gpu.render(
            &out.create_view(&Default::default()),
            camera[0],
            camera[1],
            camera[2],
            out.width(),
            out.height(),
            true,
            false,
            45.,
            90.,
            0.55,
            false,
            0.,
            0.25
        )
        .unwrap()
    );
    gpu.device
        .poll(wgpu::PollType::wait_indefinitely())
        .unwrap();
}

#[test]
fn transition_is_external_fade_of_independent_topologies_at_edges_and_corners() {
    let mut gpu = setup();
    let out = output(&gpu, 128, 128);
    // The second material exercises nonzero overlay IDs in the exact fine path.
    gpu.set_materials(&[
        0., 0., 1., 1., 0.5, 0.4, 0.5, 1., 0., 0., 0., 0., 0., 0., 1., 1., 0.2, 0.7, 0.3, 0.5, 0.,
        0., 0., 0.,
    ])
    .unwrap();
    let mut translated_reference = None;
    for p in [0, -1000, 4_000_000] {
        gpu.set_cut(vec![]).unwrap();
        for key in gpu.tiles.keys().copied().collect::<Vec<_>>() {
            gpu.remove_tile(key);
        }
        gpu.device
            .poll(wgpu::PollType::wait_indefinitely())
            .unwrap();
        let ox = p as f64 * 512.;
        let oz = -ox;
        gpu.set_world(
            [
                (ox - 512.) as i32,
                (oz - 512.) as i32,
                (ox + 512.) as i32,
                (oz + 512.) as i32,
            ],
            0,
        )
        .unwrap();
        let camera = [ox, oz, 16.];
        let key =
            |level, x, z| Key::new(level, p * (4 >> level) + x, -p * (4 >> level) + z).unwrap();
        let mut previous = Vec::new();
        let mut next = Vec::new();
        for z in -2..2 {
            for x in -2..2 {
                let k = key(1, x, z);
                gpu.add_tile(
                    k,
                    summary(
                        [
                            12000 + (x + 2) as u16 * 8000,
                            14000 + (z + 2) as u16 * 9000,
                            44000,
                        ],
                        0,
                    ),
                )
                .unwrap();
                draw_transition_fixture(&mut gpu, &out, camera);
                if (x, z) != (-1, -1) {
                    previous.push(k);
                }
                if x < 0 || z < 0 {
                    next.push(k);
                }
            }
        }
        for (x, z) in [(-1, -1), (0, -1), (-1, 0), (0, 0)] {
            let k = key(2, x, z);
            gpu.add_tile(
                k,
                summary(
                    [
                        52000,
                        22000 + (x + 1) as u16 * 10000,
                        6000 + (z + 1) as u16 * 18000,
                    ],
                    0,
                ),
            )
            .unwrap();
            draw_transition_fixture(&mut gpu, &out, camera);
            if (x, z) == (0, 0) {
                next.push(k);
            }
        }
        for (x, z) in [(-2, -2), (-1, -2), (-2, -1), (-1, -1)] {
            let k = key(0, x, z);
            let mut words = detail(0, 1);
            for (i, cell) in words.chunks_exact_mut(8).enumerate() {
                cell[3] = u32::from(i % 3 == 0);
                cell[4] = if i % 5 == 0 { 4 } else { 0 };
            }
            gpu.add_tile(k, words).unwrap();
            draw_transition_fixture(&mut gpu, &out, camera);
            previous.push(k);
        }
        let previous = unit_cut(previous);
        let next = unit_cut(next);
        let mut union = previous.clone();
        union.extend(next.iter().copied().filter(|e| !previous.contains(e)));
        assert!(
            Topology::new(union, false).is_err(),
            "the old weighted-union topology is unbalanced"
        );
        for scale in [0.125, 16.] {
            let camera = [ox, oz, scale];
            gpu.set_cut(previous.clone()).unwrap();
            draw_transition_fixture(&mut gpu, &out, camera);
            let before = pixels(&gpu, &out);
            gpu.set_cut(next.clone()).unwrap();
            draw_transition_fixture(&mut gpu, &out, camera);
            let after = pixels(&gpu, &out);
            assert_ne!(before, after);
            gpu.set_transition(previous.clone(), next.clone(), 0.)
                .unwrap();
            let entries = gpu.cuts.each_ref().map(|c| c.entries.as_ptr());
            let boundaries = gpu
                .cuts
                .each_ref()
                .map(|c| c.boundaries.values().next().unwrap() as *const Boundary);
            let allocations = gpu.allocation_bytes();
            for progress in [0., 0.25, 0.5, 0.75, 1., 0.5] {
                gpu.set_transition(previous.clone(), next.clone(), progress)
                    .unwrap();
                assert_eq!(gpu.cuts.each_ref().map(|c| c.entries.as_ptr()), entries);
                assert_eq!(
                    gpu.cuts
                        .each_ref()
                        .map(|c| c.boundaries.values().next().unwrap() as *const Boundary),
                    boundaries
                );
                draw_transition_fixture(&mut gpu, &out, camera);
                let actual = pixels(&gpu, &out);
                for (i, &value) in actual.iter().enumerate() {
                    let expected = before[i] as f32 * (1. - progress) + after[i] as f32 * progress;
                    assert!(
                        (value as f32 - expected).abs() <= 2.,
                        "external fade mismatch at origin={p},scale={scale},progress={progress},byte={i}: {value} != {expected}"
                    );
                }
                assert!(actual.chunks_exact(4).all(|pixel| pixel[3] == 255));
                assert_eq!(
                    gpu.allocation_bytes(),
                    allocations,
                    "alpha changes allocate no new persistent resources"
                );
                assert_eq!(allocations[4], out.width() as u64 * out.height() as u64 * 8);
                if progress == 0.5 && scale == 16. {
                    if let Some(reference) = &translated_reference {
                        assert_eq!(&actual, reference);
                    } else {
                        translated_reference = Some(actual);
                    }
                }
            }
        }
        let original = gpu.cuts.each_ref().map(|c| c.entries.as_ptr());
        for progress in [-0.1, 1.1, f32::NAN] {
            assert!(
                gpu.set_transition(previous.clone(), next.clone(), progress)
                    .is_err()
            );
            assert_eq!(gpu.cuts.each_ref().map(|c| c.entries.as_ptr()), original);
        }
        assert!(
            gpu.set_transition(vec![previous[0]; 65], vec![next[0]; 64], 0.5)
                .is_err()
        );
        assert!(
            gpu.set_transition(unit_cut([key(0, -1, -1), key(2, 0, 0)]), next.clone(), 0.5)
                .is_err()
        );
        assert_eq!(gpu.cuts.each_ref().map(|c| c.entries.as_ptr()), original);
        assert_eq!(gpu.transition, Some(0.5));
        // The zero-weight topology must neither keep lighting jobs alive nor
        // leak status; both contributing cuts deduplicate their shared jobs.
        gpu.set_transition(previous.clone(), next.clone(), 0.)
            .unwrap();
        draw(&mut gpu, &out, camera, false, 0.25);
        let epoch = gpu.lighting_epoch();
        assert_eq!(
            gpu.tiles
                .values()
                .filter(|t| t.lighting_epoch == epoch)
                .count(),
            1
        );
        for _ in 0..32 {
            if gpu.pending_preparations() == 0 {
                break;
            }
            draw(&mut gpu, &out, camera, false, 0.25);
        }
        assert_eq!(gpu.pending_preparations(), 0);
        assert!(
            gpu.tiles
                .iter()
                .filter(|(k, _)| k.level == 2)
                .all(|(_, t)| t.lighting_epoch != epoch)
        );
        gpu.set_transition(previous, next, 0.5).unwrap();
        draw(&mut gpu, &out, camera, false, 0.5);
        let latest = gpu.lighting_epoch();
        assert_eq!(
            gpu.tiles
                .values()
                .filter(|t| t.lighting_epoch == latest)
                .count(),
            1
        );
        for _ in 0..32 {
            if gpu.pending_preparations() == 0 {
                break;
            }
            draw(&mut gpu, &out, camera, false, 0.5);
        }
        assert_eq!(gpu.pending_preparations(), 0);
    }
}

#[test]
fn transition_missing_gutter_or_active_tile_is_an_explicit_error() {
    let mut gpu = setup();
    let out = output(&gpu, 64, 64);
    let camera = [-0.5, -0.5, 128.];
    gpu.set_world([-256, -256, 256, 256], 0).unwrap();
    let parents = [(-1, -1), (0, -1), (-1, 0), (0, 0)].map(|(x, z)| Key::new(1, x, z).unwrap());
    let child = Key::new(0, -1, -1).unwrap();
    for key in parents {
        gpu.add_tile(key, summary([16000, 32000, 48000], 0))
            .unwrap();
        draw(&mut gpu, &out, camera, false, 0.);
    }
    gpu.add_tile(child, detail(0, 1)).unwrap();
    draw(&mut gpu, &out, camera, false, 0.);
    let previous = unit_cut([child, parents[3]]);
    let next = unit_cut([parents[0], parents[3]]);
    gpu.set_transition(previous.clone(), next.clone(), 0.5)
        .unwrap();
    draw(&mut gpu, &out, camera, false, 0.);
    gpu.remove_tile(parents[1]);
    gpu.device
        .poll(wgpu::PollType::wait_indefinitely())
        .unwrap();
    let view = gpu.view.unwrap();
    let error = gpu.validate_visible_sources(view).unwrap_err().to_string();
    assert!(
        error.contains("parent/gutter") && error.contains("x: 0, z: -1"),
        "{error}"
    );
    assert!(
        gpu.render(
            &out.create_view(&Default::default()),
            camera[0],
            camera[1],
            camera[2],
            out.width(),
            out.height(),
            false,
            false,
            45.,
            90.,
            0.55,
            false,
            0.,
            0.25
        )
        .is_err()
    );
    assert_eq!(gpu.height_status()[0] & 8, 8);
    gpu.set_transition(previous.clone(), next.clone(), 1.)
        .unwrap();
    draw(&mut gpu, &out, camera, false, 0.);
    gpu.remove_tile(child);
    gpu.device
        .poll(wgpu::PollType::wait_indefinitely())
        .unwrap();
    gpu.set_transition(previous, next, 0.5).unwrap();
    let error = gpu.validate_visible_sources(view).unwrap_err().to_string();
    assert!(error.contains("active LOD transition tile"), "{error}");
    gpu.set_cut(unit_cut([parents[0]])).unwrap();
    assert!(gpu.transition.is_none());
    assert!(gpu.cuts[1].entries.is_empty());
    draw(&mut gpu, &out, camera, false, 0.);
}

#[test]
fn required_sources_plans_offview_gutters_without_residency_or_gpu_allocations() {
    let mut gpu = setup();
    let initial = gpu.gpu_bytes();
    for p in [0, -1000, 8_000_000] {
        let ox = p as f64 * 256.;
        let oz = -ox;
        gpu.set_world(
            [
                (ox - 256.) as i32,
                (oz - 256.) as i32,
                (ox + 256.) as i32,
                (oz + 256.) as i32,
            ],
            0,
        )
        .unwrap();
        let parents =
            [(-1, -1), (0, -1), (-1, 0), (0, 0)].map(|(x, z)| Key::new(1, p + x, -p + z).unwrap());
        let child = Key::new(0, p * 2 - 1, -p * 2 - 1).unwrap();
        let cut = unit_cut([child, parents[3]]);
        let sources = gpu
            .required_sources(cut.clone(), ox - 0.5, oz - 0.5, 128., 64, 64)
            .unwrap();
        assert_eq!(
            sources,
            parents
                .into_iter()
                .collect::<std::collections::BTreeSet<_>>()
                .into_iter()
                .collect::<Vec<_>>()
        );
        assert!(sources.iter().all(|key| !gpu.has_tile(*key)));
        assert_eq!(
            gpu.required_sources(cut.clone(), ox - 64., oz - 64., 128., 64, 64)
                .unwrap(),
            vec![parents[0]],
            "interior-only view retains the binding parent, not offscreen gutter sources"
        );
        assert_eq!(
            gpu.required_sources(cut.clone(), ox, oz, 1., 0, 0).unwrap(),
            vec![parents[0]]
        );
        gpu.set_world(
            [(ox - 256.) as i32, (oz - 256.) as i32, ox as i32, oz as i32],
            0,
        )
        .unwrap();
        assert_eq!(
            gpu.required_sources(cut.clone(), ox - 0.5, oz - 0.5, 128., 64, 64)
                .unwrap(),
            vec![parents[0]],
            "known outside-world gutters do not become missing resident pages"
        );
        assert!(gpu.required_sources(cut, ox, oz, f64::NAN, 64, 64).is_err());
        assert_eq!(gpu.gpu_bytes(), initial);
        assert!(gpu.cuts[0].entries.is_empty());
    }
}

fn live_heights(level: u32, words: &[u32]) -> Vec<u32> {
    if level == 0 {
        words.chunks_exact(8).map(GpuLod::detail_height).collect()
    } else {
        words
            .chunks_exact(6)
            .flat_map(|c| {
                [
                    (c[3] & 0xffff) | (c[5] & 0xffff0000),
                    (c[3] >> 16) | (c[4] << 16),
                ]
            })
            .collect()
    }
}

fn assert_live_height(gpu: &GpuLod, key: Key, expected: &[u32]) {
    let snapshot = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("bounded live height readback"),
        size: SAMPLES as u64 * 8,
        usage: wgpu::BufferUsages::COPY_SRC | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let mut encoder = gpu.device.create_command_encoder(&Default::default());
    encoder.copy_buffer_to_buffer(
        &gpu.nodes,
        gpu.heights[&key] as u64 * HEIGHT_PAGE_BYTES,
        &snapshot,
        0,
        snapshot.size(),
    );
    gpu.queue.submit([encoder.finish()]);
    let bytes = read(gpu, &snapshot);
    let actual: &[u32] = bytemuck::cast_slice(&bytes);
    if key.level == 0 {
        for (pair, word) in actual.chunks_exact(2).zip(expected) {
            assert_eq!(pair, &[*word, (word & 0xffff) * 65537]);
        }
    } else {
        assert_eq!(actual, expected);
    }
}

fn live_chunk(words: &[u32], cx: i32, cz: i32) -> Vec<u32> {
    let x = cx.rem_euclid(8) as usize * 16;
    let z = cz.rem_euclid(8) as usize * 16;
    (0..16)
        .flat_map(|row| {
            words[((z + row) * 128 + x) * 8..((z + row) * 128 + x + 16) * 8]
                .iter()
                .copied()
        })
        .collect()
}

#[test]
fn live_full_surface_and_height_replace_in_one_frame_with_retirement() {
    let mut gpu = setup();
    let out = output(&gpu, 64, 64);
    for level in [0, 1] {
        gpu.set_cut(vec![]).unwrap();
        let key = Key::new(level, -1, 0).unwrap();
        let old = if level == 0 {
            detail(-16, 1)
        } else {
            summary([12000, 25000, 40000], -16)
        };
        gpu.replace_surface(key, old.clone(), live_heights(level, &old))
            .unwrap();
        draw(&mut gpu, &out, [-64., 64., 1.], false, 0.);
        gpu.set_cut(unit_cut([key])).unwrap();
        draw(&mut gpu, &out, [-64., 64., 1.], false, 0.);
        let before_pixels = pixels(&gpu, &out);
        let before_bytes = gpu.gpu_bytes();
        let slot = gpu.heights[&key];
        let new = if level == 0 {
            detail(48, 0)
        } else {
            summary([60000, 1000, 1000], 48)
        };
        let heights = live_heights(level, &new);
        gpu.replace_surface(key, new.clone(), heights.clone())
            .unwrap();
        assert_eq!(gpu.pending_uploads(), 1);
        assert_eq!(gpu.heights[&key], slot);
        assert_eq!(
            read(&gpu, &gpu.tiles[&key].data),
            bytemuck::cast_slice::<u32, u8>(&old)
        );
        assert_live_height(&gpu, key, &live_heights(level, &old));
        assert!(
            gpu.render(
                &out.create_view(&Default::default()),
                -64.,
                64.,
                1.,
                64,
                64,
                false,
                false,
                45.,
                90.,
                0.55,
                false,
                0.,
                0.25,
            )
            .unwrap()
        );
        assert_eq!(gpu.pending_uploads(), 0);
        assert_ne!(gpu.heights[&key], slot);
        assert!(
            gpu.has_tile(key),
            "updated coarse tile is shaded in its update frame"
        );
        assert!(
            gpu.retirement
                .lock()
                .unwrap()
                .entries
                .iter()
                .any(|r| r.slots.contains(&slot))
        );
        gpu.device
            .poll(wgpu::PollType::wait_indefinitely())
            .unwrap();
        assert_eq!(
            read(&gpu, &gpu.tiles[&key].data),
            bytemuck::cast_slice::<u32, u8>(&new)
        );
        assert_live_height(&gpu, key, &heights);
        assert_ne!(pixels(&gpu, &out), before_pixels);
        assert_eq!(gpu.gpu_bytes(), before_bytes);
    }
}

#[test]
fn live_chunk_rows_preserve_untouched_negative_chunks_and_full_patch_is_bounded() {
    let mut gpu = setup();
    let out = output(&gpu, 64, 64);
    let key = Key::new(0, -1, -1).unwrap();
    let original = detail(16, 1);
    gpu.replace_surface(key, original.clone(), live_heights(0, &original))
        .unwrap();
    draw(&mut gpu, &out, [-64., -64., 1.], false, 0.);
    gpu.set_cut(unit_cut([key])).unwrap();
    draw(&mut gpu, &out, [-120., -120., 4.], false, 0.);
    let old_pixels = pixels(&gpu, &out);
    let data = gpu.tiles[&key].data.clone();
    let base = gpu.gpu_bytes();
    let mut expected = original.clone();
    let coordinates: Vec<[i32; 2]> = vec![[-8, -8], [-1, -1]];
    for [cx, cz] in &coordinates {
        let x = cx.rem_euclid(8) as usize * 16;
        let z = cz.rem_euclid(8) as usize * 16;
        for row in 0..16 {
            for column in 0..16 {
                let cell = &mut expected[((z + row) * 128 + x + column) * 8..][..8];
                cell[0] = (-32i32) as u32;
                cell[7] = if *cx == -8 { 0 } else { 1 };
                cell[4] = if *cx == -8 { 0 } else { 8 };
            }
        }
    }
    let patch: Vec<u32> = coordinates
        .iter()
        .flat_map(|[cx, cz]| live_chunk(&expected, *cx, *cz))
        .collect();
    let heights = live_heights(0, &expected);
    gpu.patch_chunks(key, coordinates, patch, heights.clone())
        .unwrap();
    assert_eq!(gpu.pending_uploads(), 1);
    assert_eq!(
        read(&gpu, &data),
        bytemuck::cast_slice::<u32, u8>(&original)
    );
    let mut encoder = gpu.device.create_command_encoder(&Default::default());
    gpu.prepare_one(&mut encoder).unwrap();
    assert_eq!(
        gpu.tiles[&key].data, data,
        "patches reuse the resident surface buffer"
    );
    assert_eq!(
        gpu.gpu_bytes(),
        base + gpu.surface_update_bytes(0, 2).unwrap()
    );
    gpu.submit(encoder);
    draw(&mut gpu, &out, [-120., -120., 4.], false, 0.);
    assert_ne!(pixels(&gpu, &out), old_pixels);
    assert_eq!(
        read(&gpu, &data),
        bytemuck::cast_slice::<u32, u8>(&expected)
    );
    assert_live_height(&gpu, key, &heights);
    assert_eq!(gpu.gpu_bytes(), base);

    let coordinates: Vec<_> = (-8..0).flat_map(|z| (-8..0).map(move |x| [x, z])).collect();
    let all = detail(80, 1);
    let words = coordinates
        .iter()
        .flat_map(|[x, z]| live_chunk(&all, *x, *z))
        .collect();
    gpu.patch_chunks(key, coordinates, words, live_heights(0, &all))
        .unwrap();
    draw(&mut gpu, &out, [-64., -64., 1.], false, 0.);
    assert_eq!(read(&gpu, &data), bytemuck::cast_slice::<u32, u8>(&all));
    assert_live_height(&gpu, key, &live_heights(0, &all));
    assert!(gpu.surface_update_bytes(0, 64).unwrap() <= MAX_UPDATE_BYTES);
    assert!(gpu.upload_peak_bytes() < MAX_QUEUE_BYTES);
}

#[test]
fn live_updates_validate_every_input_before_queue_or_gpu_mutation() {
    let mut gpu = setup();
    let out = output(&gpu, 64, 64);
    let key = Key::new(0, -1, -1).unwrap();
    let valid = detail(-16, 1);
    let heights = live_heights(0, &valid);
    gpu.replace_surface(key, valid.clone(), heights.clone())
        .unwrap();
    draw(&mut gpu, &out, [-64., -64., 1.], false, 0.);
    let base = gpu.gpu_bytes();
    let slot = gpu.heights[&key];
    let revision = gpu.feedback_revision;
    for (field, bad) in [
        (0, 32768),
        (0, (-32768i32) as u32),
        (1, 1),
        (2, 0x1000000),
        (3, 1),
        (4, 385),
        (5, 1),
        (6, 32768),
        (7, 4),
    ] {
        let mut words = valid.clone();
        words[(SAMPLES - 1) * 8 + field] = bad;
        assert!(
            gpu.replace_surface(key, words.clone(), heights.clone())
                .is_err()
        );
        assert!(
            gpu.patch_chunks(
                key,
                vec![[-1, -1]],
                live_chunk(&words, -1, -1),
                heights.clone()
            )
            .is_err()
        );
    }
    for bad in [
        0,
        3 << 16,
        32 << 16,
        (1 << 16) | 32768,
        (4 << 16) | 16,
        (17 << 16) | 16,
    ] {
        let mut h = heights.clone();
        h[SAMPLES - 1] = bad;
        assert!(gpu.replace_surface(key, valid.clone(), h.clone()).is_err());
        assert!(
            gpu.patch_chunks(key, vec![[-1, -1]], live_chunk(&valid, -1, -1), h)
                .is_err()
        );
    }
    for count in [0, 1, SAMPLES * 8 - 1, SAMPLES * 8 + 1] {
        assert!(
            gpu.replace_surface(key, vec![0; count], heights.clone())
                .is_err()
        );
    }
    assert!(
        gpu.replace_surface(key, valid.clone(), heights[..SAMPLES - 1].to_vec())
            .is_err()
    );
    for coordinates in [
        vec![],
        vec![[-8, -8]; 2],
        vec![[-9, -8]],
        vec![[0, -8]],
        vec![[-8, i32::MIN]],
        vec![[-8, -8]; 65],
    ] {
        assert!(
            gpu.patch_chunks(
                key,
                coordinates.clone(),
                vec![0; coordinates.len() * 256 * 8],
                heights.clone()
            )
            .is_err()
        );
    }
    assert!(
        gpu.patch_chunks(key, vec![[-8, -8]], vec![0; 2047], heights.clone())
            .is_err()
    );
    for invalid in [
        Key {
            level: 17,
            x: 0,
            z: 0,
        },
        Key {
            level: 0,
            x: 65536,
            z: 0,
        },
        Key {
            level: 0,
            x: -65537,
            z: 0,
        },
        Key {
            level: 0,
            x: 0,
            z: i32::MAX,
        },
    ] {
        assert!(
            gpu.replace_surface(invalid, valid.clone(), heights.clone())
                .is_err()
        );
    }
    let coarse = Key::new(1, -1, -1).unwrap();
    let valid_coarse = summary([20000; 3], 0);
    for (field, value) in [
        (3, 16 << 16),
        (4, 0xffff),
        (5, 0),
        (5, (1 << 16) | 255),
        (5, (1 << 16) | (255 << 8)),
    ] {
        let mut words = valid_coarse.clone();
        words[field] = value;
        assert!(
            gpu.replace_surface(coarse, words.clone(), live_heights(1, &words))
                .is_err()
        );
    }
    let mut mismatch = live_heights(1, &valid_coarse);
    mismatch[0] += 1;
    assert!(gpu.replace_surface(coarse, valid_coarse, mismatch).is_err());
    assert_eq!(gpu.pending_uploads(), 0);
    assert_eq!(gpu.heights[&key], slot);
    assert_eq!(gpu.feedback_revision, revision);
    assert_eq!(gpu.gpu_bytes(), base);
    assert_eq!(
        read(&gpu, &gpu.tiles[&key].data),
        bytemuck::cast_slice::<u32, u8>(&valid)
    );
    assert_live_height(&gpu, key, &heights);
}

#[test]
fn live_queue_coalesces_full_updates_cancels_pairs_and_reserves_height_slots() {
    let mut gpu = setup();
    let out = output(&gpu, 64, 64);
    let key = Key::new(0, 0, 0).unwrap();
    let words = detail(0, 1);
    let heights = live_heights(0, &words);
    gpu.add_tile(key, words.clone()).unwrap();
    gpu.add_height(key, heights.clone()).unwrap();
    assert_eq!(gpu.pending_uploads(), 2);
    gpu.replace_surface(key, words.clone(), heights.clone())
        .unwrap();
    assert_eq!(gpu.pending_uploads(), 1);
    assert!(gpu.add_tile(key, words.clone()).is_err());
    assert!(gpu.add_height(key, heights.clone()).is_err());
    for x in 1..3 {
        gpu.replace_surface(Key::new(0, x, 0).unwrap(), words.clone(), heights.clone())
            .unwrap();
    }
    assert!(
        gpu.replace_surface(Key::new(0, 3, 0).unwrap(), words.clone(), heights.clone())
            .is_err()
    );
    assert_eq!(gpu.pending_uploads(), 3);
    assert_eq!(gpu.available_height_slots(), gpu.height_capacity() - 4);
    assert!(gpu.cpu_bytes() < MAX_QUEUE_BYTES);
    gpu.remove_tile(Key::new(0, 1, 0).unwrap());
    gpu.remove_height(Key::new(0, 2, 0).unwrap());
    assert_eq!(gpu.pending_uploads(), 1);
    draw(&mut gpu, &out, [64., 64., 1.], false, 0.);
    let patch = live_chunk(&words, 0, 0);
    gpu.patch_chunks(key, vec![[0, 0]], patch.clone(), heights.clone())
        .unwrap();
    assert!(
        gpu.patch_chunks(key, vec![[1, 0]], patch, heights.clone())
            .is_err()
    );
    let replacement = detail(32, 1);
    gpu.replace_surface(key, replacement.clone(), live_heights(0, &replacement))
        .unwrap();
    draw(&mut gpu, &out, [64., 64., 1.], false, 0.);
    assert_eq!(
        read(&gpu, &gpu.tiles[&key].data),
        bytemuck::cast_slice::<u32, u8>(&replacement)
    );
    gpu.remove_height(key);
    gpu.device
        .poll(wgpu::PollType::wait_indefinitely())
        .unwrap();
    gpu.patch_chunks(
        key,
        vec![[0, 0]],
        live_chunk(&replacement, 0, 0),
        live_heights(0, &replacement),
    )
    .unwrap();
    draw(&mut gpu, &out, [64., 64., 1.], false, 0.);
    assert_live_height(&gpu, key, &live_heights(0, &replacement));
    gpu.reap();
    let slots = std::mem::take(&mut gpu.free_slots);
    gpu.retirement.lock().unwrap().free_slots.clear();
    assert!(
        gpu.replace_surface(key, words.clone(), heights.clone())
            .is_err()
    );
    assert_eq!(gpu.pending_uploads(), 0);
    gpu.free_slots = slots;
    for level in 0..=16 {
        assert!(gpu.surface_update_bytes(level, 0).unwrap() <= MAX_UPDATE_BYTES);
    }
    assert!(gpu.surface_update_bytes(17, 0).is_err());
    assert!(gpu.surface_update_bytes(1, 1).is_err());
    assert!(gpu.surface_update_bytes(0, 65).is_err());
    gpu.dispose();
    assert!(gpu.replace_surface(key, words, heights).is_err());
    assert_eq!(gpu.pending_uploads(), 0);
}

#[test]
fn live_material_growth_preserves_values_and_rebinds_without_cpu_catalog_copy() {
    let mut gpu = setup();
    let out = output(&gpu, 64, 64);
    let key = Key::new(0, 0, 0).unwrap();
    let words = detail(0, 1);
    gpu.replace_surface(key, words.clone(), live_heights(0, &words))
        .unwrap();
    draw(&mut gpu, &out, [64., 64., 1.], false, 0.);
    gpu.set_cut(unit_cut([key])).unwrap();
    draw(&mut gpu, &out, [64., 64., 1.], false, 0.);
    let before = pixels(&gpu, &out);
    let original = read(&gpu, &gpu.material_buffer);
    let gpu_before = gpu.gpu_bytes();
    let cpu_before = gpu.cpu_bytes();
    gpu.grow_materials(65536).unwrap();
    assert_eq!(gpu.gpu_bytes(), gpu_before + 65536 * 48);
    assert!(gpu.cpu_bytes() < cpu_before + 4096);
    let grown = read(&gpu, &gpu.material_buffer);
    assert_eq!(&grown[..original.len()], &original);
    assert!(grown[original.len()..].iter().all(|v| *v == 0));
    assert_eq!(gpu.gpu_bytes(), gpu_before + 65535 * 48);
    draw(&mut gpu, &out, [64., 64., 1.], false, 0.);
    assert_eq!(pixels(&gpu, &out), before);
    let appended = [0., 0., 1., 1., 0.1, 0.8, 0.2, 1., 0., 0., 0., 0.];
    gpu.update_materials(65535, &appended).unwrap();
    let after = read(&gpu, &gpu.material_buffer);
    assert_eq!(&after[..48], &original);
    assert_eq!(
        &after[65535 * 48..],
        bytemuck::cast_slice::<f32, u8>(&appended)
    );
    let mut updated = words;
    for c in updated.chunks_exact_mut(8) {
        c[1] = 65535;
    }
    gpu.replace_surface(key, updated.clone(), live_heights(0, &updated))
        .unwrap();
    draw(&mut gpu, &out, [64., 64., 1.], false, 0.);
    assert_ne!(pixels(&gpu, &out), before);
    let allocated = gpu.gpu_bytes();
    assert!(gpu.grow_materials(65535).is_err());
    assert!(gpu.grow_materials(65537).is_err());
    gpu.grow_materials(65536).unwrap();
    assert_eq!(gpu.gpu_bytes(), allocated);
    assert_eq!(gpu.material_count, 65536);
}

#[test]
fn live_surface_updates_dirty_coarse_shadows_and_restitch_neighbor_colors() {
    let mut gpu = setup();
    let out = output(&gpu, 64, 64);
    let left = Key::new(1, -1, 0).unwrap();
    let right = Key::new(1, 0, 0).unwrap();
    let fine = Key::new(0, -1, 0).unwrap();
    for key in [left, right] {
        let words = summary([12000, 25000, 40000], 16);
        gpu.replace_surface(key, words.clone(), live_heights(1, &words))
            .unwrap();
        draw(&mut gpu, &out, [0., 64., 1.], false, 0.);
    }
    gpu.set_cut(unit_cut([left, right])).unwrap();
    for _ in 0..2 {
        draw(&mut gpu, &out, [0., 64., 1.], false, 0.);
    }
    assert!(!gpu.tiles[&left].dirty && !gpu.tiles[&right].dirty);
    let words = detail(16, 1);
    gpu.replace_surface(fine, words.clone(), live_heights(0, &words))
        .unwrap();
    draw(&mut gpu, &out, [0., 64., 1.], false, 0.);
    assert!(gpu.tiles[&left].dirty && gpu.tiles[&right].dirty);
    for _ in 0..2 {
        draw(&mut gpu, &out, [0., 64., 1.], false, 0.);
    }
    gpu.patch_chunks(
        fine,
        vec![[-1, 0]],
        live_chunk(&words, -1, 0),
        live_heights(0, &words),
    )
    .unwrap();
    draw(&mut gpu, &out, [0., 64., 1.], false, 0.);
    assert!(gpu.tiles[&left].dirty && gpu.tiles[&right].dirty);

    let words = summary([60000, 1000, 1000], 32);
    gpu.replace_surface(left, words.clone(), live_heights(1, &words))
        .unwrap();
    draw(&mut gpu, &out, [0., 64., 1.], false, 0.);
    assert!(!gpu.tiles[&left].dirty && gpu.tiles[&right].dirty);
    draw(&mut gpu, &out, [0., 64., 1.], false, 0.);
    assert!(!gpu.tiles[&right].dirty);
    let pixel = |key, x, lit| {
        let tile = &gpu.tiles[&key];
        let image = if lit {
            tile.lit.as_ref().unwrap()
        } else {
            tile.color.as_ref().unwrap()
        };
        let snapshot = gpu.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("one live gutter texel"),
            size: 256,
            usage: wgpu::BufferUsages::COPY_SRC | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let mut encoder = gpu.device.create_command_encoder(&Default::default());
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: image,
                mip_level: 0,
                origin: wgpu::Origin3d { x, y: 64, z: 0 },
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &snapshot,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(256),
                    rows_per_image: Some(1),
                },
            },
            wgpu::Extent3d {
                width: 1,
                height: 1,
                depth_or_array_layers: 1,
            },
        );
        gpu.queue.submit([encoder.finish()]);
        read(&gpu, &snapshot)[..8].to_vec()
    };
    for lit in [false, true] {
        assert_eq!(pixel(left, 128, lit), pixel(right, 0, lit));
        assert_ne!(pixel(right, 0, lit), pixel(right, 1, lit));
    }
}

#[test]
fn submission_timing_tracks_three_oldest_ages_and_completion_progress() {
    let mut times = SubmissionTimes::default();
    assert_eq!(times.oldest(0, 100.), (0., true));
    for serial in 1..=3 {
        times.record(serial, 0, serial as f64 * 10.);
    }
    assert_eq!(times.entries.iter().flatten().count(), 3);
    assert_eq!(times.oldest(0, 100.), (90., true));
    assert_eq!(
        times.oldest(0, 200.),
        (190., true),
        "no acknowledgement: same oldest submission keeps aging"
    );
    assert_eq!(times.oldest(1, 200.), (180., true));
    assert_eq!(times.oldest(2, 200.), (170., true));
    assert_eq!(times.oldest(3, 200.), (0., true));
    times.record(4, 1, 210.);
    assert_eq!(times.entries.map(|e| e.unwrap().first), [2, 3, 4]);
    assert_eq!(times.oldest(3, 220.), (10., true));
    times.record(5, 4, 230.);
    assert_eq!(times.entries.iter().flatten().count(), 1);
    assert_eq!(times.oldest(4, 230.), (0., true));
    assert_eq!(times.oldest(5, 240.), (0., true));
}

#[test]
fn submission_timing_non_frame_overflow_is_bounded_and_explicitly_inexact() {
    let mut times = SubmissionTimes::default();
    for serial in 1..=1000 {
        times.record(serial, 0, serial as f64);
    }
    assert_eq!(times.entries.iter().flatten().count(), 3);
    assert_eq!(times.entries[2].unwrap().first, 3);
    assert_eq!(times.entries[2].unwrap().last, 1000);
    assert_eq!(times.oldest(0, 1100.), (1099., true));
    assert_eq!(times.oldest(2, 1100.), (1097., true));
    assert_eq!(times.oldest(3, 1100.), (1097., false));
    assert_eq!(times.oldest(999, 1100.), (1097., false));
    times.record(1001, 999, 1200.);
    assert_eq!(times.entries.iter().flatten().count(), 2);
    assert_eq!(times.oldest(1000, 1210.), (10., true));
    assert_eq!(times.oldest(1001, 1210.), (0., true));
    times.record(1002, 1001, 1300.);
    assert_eq!(times.entries.iter().flatten().count(), 1);
    assert_eq!(times.oldest(1001, 1310.), (10., true));
    assert_eq!(
        times.oldest(1001, 1299.),
        (0., true),
        "age never becomes negative"
    );
}

#[test]
fn submission_stats_are_read_only_monotonic_and_clear_on_dispose() {
    let mut gpu = setup();
    let before = gpu.submission_stats();
    assert!(
        before.submitted_serial > 0,
        "initial atlas work is instrumented"
    );
    assert_eq!(before.completed_serial, before.submitted_serial);
    assert_eq!(before.oldest_in_flight_age_ms, 0.);
    assert!(before.oldest_in_flight_age_exact);
    let clock_before = gpu.submission_clock.now_ms();
    assert!(gpu.submission_clock.now_ms() >= clock_before);
    for _ in 0..6 {
        gpu.submit(gpu.device.create_command_encoder(&Default::default()));
    }
    let inflight = gpu.submission_stats();
    assert_eq!(inflight.submitted_serial, before.submitted_serial + 6);
    assert!(
        (before.completed_serial..=inflight.submitted_serial).contains(&inflight.completed_serial)
    );
    assert!(inflight.oldest_in_flight_age_ms.is_finite() && inflight.oldest_in_flight_age_ms >= 0.);
    assert!(gpu.submission_times.entries.iter().flatten().count() <= 3);
    assert_eq!(
        gpu.submitted, inflight.submitted_serial,
        "reading stats submits no work"
    );
    gpu.device
        .poll(wgpu::PollType::wait_indefinitely())
        .unwrap();
    let settled = gpu.submission_stats();
    assert_eq!(settled.submitted_serial, inflight.submitted_serial);
    assert_eq!(settled.completed_serial, settled.submitted_serial);
    assert_eq!(settled.oldest_in_flight_age_ms, 0.);
    assert!(settled.oldest_in_flight_age_exact);
    gpu.submit(gpu.device.create_command_encoder(&Default::default()));
    gpu.dispose();
    let disposed = SubmissionStats {
        oldest_in_flight_age_exact: true,
        ..Default::default()
    };
    assert_eq!(gpu.submission_stats(), disposed);
    assert!(gpu.submission_times.entries.iter().all(Option::is_none));
    gpu.device
        .poll(wgpu::PollType::wait_indefinitely())
        .unwrap();
    assert_eq!(
        gpu.submission_stats(),
        disposed,
        "late callbacks cannot restore disposed diagnostics"
    );
}
