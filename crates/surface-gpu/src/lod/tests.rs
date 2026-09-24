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
            gpu.boundaries[&children[0]].weights[7], 1.,
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
