use crate::*;
use surface_core::lod::{
    DetailTile, EMPTY, PRESENT, SummarySample, SummaryTile, TILE_CELLS, TileKey,
};
use wgpu::util::DeviceExt;

fn buffer(device: &wgpu::Device, data: &[u8], usage: wgpu::BufferUsages) -> wgpu::Buffer {
    device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: None,
        contents: data,
        usage,
    })
}

fn entry(binding: u32, buffer: &wgpu::Buffer) -> wgpu::BindGroupEntry<'_> {
    wgpu::BindGroupEntry {
        binding,
        resource: buffer.as_entire_binding(),
    }
}

fn read(device: &wgpu::Device, output: &wgpu::Buffer) -> Vec<u8> {
    let (tx, rx) = std::sync::mpsc::channel();
    output
        .slice(..)
        .map_async(wgpu::MapMode::Read, move |r| tx.send(r).unwrap());
    device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
    rx.recv().unwrap().unwrap();
    let data = output.slice(..).get_mapped_range().unwrap().to_vec();
    output.unmap();
    data
}

struct Overview<'a> {
    device: &'a wgpu::Device,
    queue: &'a wgpu::Queue,
    pipeline: wgpu::ComputePipeline,
}

impl<'a> Overview<'a> {
    fn new(device: &'a wgpu::Device, queue: &'a wgpu::Queue) -> Self {
        Self {
            device,
            queue,
            pipeline: compute_pipeline(device, "LOD overview tests", OVERVIEW_SHADER, "overview"),
        }
    }

    fn pixels(
        &self,
        words: &[u32],
        origin: [f32; 4],
        params: [f32; 20],
        heights: &[f32],
        materials: &[f32],
    ) -> Vec<u8> {
        let side = origin[3] as u32;
        let p = buffer(
            self.device,
            bytemuck::cast_slice(&params),
            wgpu::BufferUsages::UNIFORM,
        );
        let o = buffer(
            self.device,
            bytemuck::cast_slice(&origin),
            wgpu::BufferUsages::UNIFORM,
        );
        let c = buffer(
            self.device,
            bytemuck::cast_slice(words),
            wgpu::BufferUsages::STORAGE,
        );
        let m = buffer(
            self.device,
            bytemuck::cast_slice(materials),
            wgpu::BufferUsages::STORAGE,
        );
        let tree = surface_core::height_pyramid(heights, params[10] as usize, params[11] as usize);
        let h = buffer(
            self.device,
            bytemuck::cast_slice(&tree),
            wgpu::BufferUsages::STORAGE,
        );
        let texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: None,
            size: wgpu::Extent3d {
                width: side,
                height: side,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = texture.create_view(&Default::default());
        let global = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &self.pipeline.get_bind_group_layout(0),
            entries: &[entry(0, &p), entry(1, &m), entry(2, &h)],
        });
        let tile = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &self.pipeline.get_bind_group_layout(1),
            entries: &[
                entry(0, &c),
                entry(1, &o),
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(&view),
                },
            ],
        });
        let row_bytes = (side * 4).div_ceil(256) * 256;
        let output = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: u64::from(row_bytes * side),
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let mut encoder = self.device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_compute_pass(&Default::default());
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &global, &[]);
            pass.set_bind_group(1, &tile, &[]);
            pass.dispatch_workgroups(side.div_ceil(8), side.div_ceil(8), 1);
        }
        encoder.copy_texture_to_buffer(
            texture.as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: &output,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(row_bytes),
                    rows_per_image: Some(side),
                },
            },
            texture.size(),
        );
        self.queue.submit([encoder.finish()]);
        read(self.device, &output)
            .chunks(row_bytes as usize)
            .flat_map(|row| row[..side as usize * 4].iter().copied())
            .collect()
    }
}

fn near(pixel: &[u8], expected: [f32; 4]) {
    for (actual, expected) in pixel.iter().zip(expected) {
        assert!(
            (f32::from(*actual) - (expected * 255.).round()).abs() <= 1.,
            "{pixel:?}, expected {expected}"
        );
    }
}

#[test]
fn gpu_lod_summary_colors_coverage_and_world_height_mapping() {
    pollster::block_on(async {
        let instance = wgpu::Instance::default();
        let adapter = instance
            .request_adapter(&Default::default())
            .await
            .expect("GPU adapter required");
        let (device, queue) = adapter.request_device(&Default::default()).await.unwrap();
        let overview = Overview::new(&device, &queue);
        let mut sample = SummarySample::absent(PRESENT | EMPTY);
        sample.original = [13107, 26214, 39321];
        sample.vivid = [39321, 13107, 26214];
        sample.mean_height = -32;
        sample.min_height = -48;
        sample.max_height = 16;
        sample.present_fraction = 128;
        sample.empty_fraction = 127;
        let key = TileKey::new(3, -1, 0).unwrap();
        let mut tile = SummaryTile {
            key,
            samples: vec![sample; TILE_CELLS],
        };
        tile.samples[127] = SummarySample::absent(EMPTY);
        let words = lod_support::pack_surface(key, tile.gpu_words(), 1).unwrap();
        let mut params = [
            0., 0., 1., 128., 128., 0., 0., 1., -1024., 0., 64., 64., 0.5, 0., 1., 0., 0., 0.25,
            2., 0.,
        ];
        for vivid in [0, 1] {
            params[13] = vivid as f32;
            let pixels = overview.pixels(
                &words,
                [-1024., 0., 8., 128.],
                params,
                &[-2.; 4096],
                &[0.; 12],
            );
            let color = if vivid == 0 {
                sample.original
            } else {
                sample.vivid
            };
            let alpha = 128. / 255.;
            near(
                &pixels[..4],
                [
                    f32::from(color[0]) / 65535. * alpha,
                    f32::from(color[1]) / 65535. * alpha,
                    f32::from(color[2]) / 65535. * alpha,
                    alpha,
                ],
            );
            assert_eq!(&pixels[127 * 4..128 * 4], &[0, 0, 0, 0]);
        }
        // The tile stride is 8 blocks, the height-window stride only 2. At tile
        // sample X=2, both stratified rays encounter X=12 in the height window;
        // sample X=0 is too far away. An id-as-height-coordinate bug swaps this.
        params[6] = 1.;
        params[13] = 0.;
        let mut heights = vec![-2.; 4096];
        for z in 0..64 {
            heights[z * 64 + 12] = 8.;
        }
        let pixels = overview.pixels(&words, [-1024., 0., 8., 128.], params, &heights, &[0.; 12]);
        let a = 128. / 255.;
        near(&pixels[..4], [0.2 * a, 0.4 * a, 0.6 * a, a]);
        near(&pixels[8..12], [0.1 * a, 0.2 * a, 0.3 * a, a]);

        // Inverse mismatch: tile stride 2, global height stride 8. Shadows must
        // use subcells, and the signed negative representative height is kept.
        params[18] = 8.;
        let key = TileKey::new(1, -4, 0).unwrap();
        tile.key = key;
        let words = lod_support::pack_surface(key, tile.gpu_words(), 1).unwrap();
        heights.fill(-2.);
        for z in 0..64 {
            heights[z * 64 + 3] = 4.;
        }
        let pixels = overview.pixels(&words, [-1024., 0., 2., 128.], params, &heights, &[0.; 12]);
        near(&pixels[10 * 4..11 * 4], [0.1 * a, 0.2 * a, 0.3 * a, a]);

        // Compile the actual render pipeline too, including generalized vertex
        // bounds and exact fine-material path (not merely the compute module).
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: None,
            source: wgpu::ShaderSource::Wgsl(TERRAIN_SHADER.into()),
        });
        let _ = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: None,
            layout: None,
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs"),
                buffers: &[],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs"),
                targets: &[Some(wgpu::TextureFormat::Rgba8Unorm.into())],
                compilation_options: Default::default(),
            }),
            primitive: Default::default(),
            depth_stencil: None,
            multisample: Default::default(),
            multiview_mask: None,
            cache: None,
        });
    });
}

#[test]
fn gpu_fine_and_legacy_overviews_keep_core_appearance() {
    pollster::block_on(async {
        let instance = wgpu::Instance::default();
        let adapter = instance
            .request_adapter(&Default::default())
            .await
            .expect("GPU adapter required");
        let (device, queue) = adapter.request_device(&Default::default()).await.unwrap();
        let overview = Overview::new(&device, &queue);
        let materials: Vec<_> = [
            ("unknown", 0, [0.; 4]),
            ("grass", 1, [0.5, 0.5, 0.5, 1.]),
            ("sand", 0, [0.8, 0.7, 0.5, 1.]),
            ("water", 3, [0.1, 0.4, 0.7, 1.]),
            ("leaves", 2, [0.5, 0.5, 0.5, 0.5]),
        ]
        .into_iter()
        .map(|(name, tint, average)| surface_core::Material {
            key: name.into(),
            name: name.into(),
            texture: name.into(),
            tint,
            approximate: false,
            uv: [0.; 4],
            average,
        })
        .collect();
        let material_words: Vec<f32> = materials
            .iter()
            .flat_map(|m| {
                [
                    m.uv,
                    m.average,
                    [m.tint as f32, f32::from(m.name == "sand"), 0., 0.],
                ]
                .concat()
            })
            .collect();
        let key = TileKey::new(0, -1, 0).unwrap();
        let mut tile = DetailTile::unknown(key).unwrap();
        for (i, c) in tile.columns.iter_mut().enumerate() {
            *c = [
                1,
                -32,
                1 + (i % 4) as i32,
                0x79b249,
                -1,
                if i % 3 == 0 { 4 } else { 0 },
                -32,
                if i % 7 == 0 { 3 } else { 0 },
                2,
                -48,
            ];
        }
        let words = tile.gpu_words();
        for vivid in [0, 1] {
            let params = [
                0.,
                0.,
                1.,
                128.,
                128.,
                0.,
                0.,
                1.,
                -128.,
                0.,
                128.,
                128.,
                0.,
                vivid as f32,
                1.,
                0.,
                0.,
                0.25,
                1.,
                0.,
            ];
            let pixels = overview.pixels(
                &words,
                [-128., 0., 1., 128.],
                params,
                &[-2.; TILE_CELLS],
                &material_words,
            );
            for (i, c) in tile.columns.iter().take(30).enumerate() {
                let color = surface_core::lod::appearance_colors(c, &materials).unwrap()[vivid];
                near(
                    &pixels[i * 4..i * 4 + 4],
                    [color[0], color[1], color[2], 1.],
                );
            }
            // Legacy reduced records still use the original coverage-count
            // encoding, not the new summary marker or quantized fractions.
            let mut legacy = words.clone();
            for c in legacy.chunks_exact_mut(8) {
                c[7] = 1 | (2 << 8);
            }
            let legacy_pixels = overview.pixels(
                &legacy,
                [-256., 0., 2., 128.],
                params,
                &[-2.; TILE_CELLS],
                &material_words,
            );
            for i in 0..30 {
                for channel in 0..4 {
                    assert!(
                        (f32::from(legacy_pixels[i * 4 + channel])
                            - f32::from(pixels[i * 4 + channel]) * 0.5)
                            .abs()
                            <= 1.
                    );
                }
            }
        }
    });
}

#[test]
fn gpu_lod_vertex_spans_and_scissored_parent_child_cut() {
    pollster::block_on(async {
        let instance = wgpu::Instance::default();
        let adapter = instance
            .request_adapter(&Default::default())
            .await
            .expect("GPU adapter required");
        let (device, queue) = adapter.request_device(&Default::default()).await.unwrap();
        // Use the real terrain vertex entry point with a diagnostic fragment.
        // Alpha blending makes any accidental parent/child overdraw observable.
        let code = format!(
            "{TERRAIN_SHADER}\n@fragment fn clip_test(v:Vertex)->@location(0) vec4f {{ return vec4f(select(vec3f(0,0,1),vec3f(1,0,0),origin.z==p.relief.w),0.5); }}"
        );
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: None,
            source: wgpu::ShaderSource::Wgsl(code.into()),
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: None,
            layout: None,
            vertex: wgpu::VertexState {
                module: &module,
                entry_point: Some("vs"),
                buffers: &[],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &module,
                entry_point: Some("clip_test"),
                targets: &[Some(wgpu::ColorTargetState {
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            primitive: Default::default(),
            depth_stencil: None,
            multisample: Default::default(),
            multiview_mask: None,
            cache: None,
        });
        let (width, height) = (192, 160);
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: None,
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = texture.create_view(&Default::default());
        let output = device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: u64::from(width * height * 4),
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        for level in [1, 3, 16] {
            let span = 128 << level;
            let half = span / 2;
            let cut = lod_support::draw_cut(&[
                level,
                -1,
                0,
                -span,
                0,
                -half,
                half,
                level - 1,
                -1,
                0,
                -half,
                0,
                0,
                half,
                level,
                -1,
                0,
                -span,
                half,
                0,
                span,
            ])
            .unwrap();
            for (cx, cz, scale) in [
                (-half as f32, half as f32, 140. / span as f32),
                (-half as f32 + 0.37, half as f32 - 0.13, 311. / span as f32),
            ] {
                let mut params = [0.; 20];
                params[..5].copy_from_slice(&[cx, cz, scale, width as f32, height as f32]);
                params[19] = (1 << level) as f32;
                let p = buffer(
                    &device,
                    bytemuck::cast_slice(&params),
                    wgpu::BufferUsages::UNIFORM,
                );
                let global = device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: None,
                    layout: &pipeline.get_bind_group_layout(0),
                    entries: &[entry(0, &p)],
                });
                let groups: Vec<_> = cut
                    .iter()
                    .map(|draw| {
                        let bounds = draw.key.bounds().unwrap();
                        let o = buffer(
                            &device,
                            bytemuck::cast_slice(&[
                                bounds[0] as f32,
                                bounds[1] as f32,
                                (1 << draw.key.level) as f32,
                                128.,
                            ]),
                            wgpu::BufferUsages::UNIFORM,
                        );
                        device.create_bind_group(&wgpu::BindGroupDescriptor {
                            label: None,
                            layout: &pipeline.get_bind_group_layout(1),
                            entries: &[entry(1, &o)],
                        })
                    })
                    .collect();
                let scissors: Vec<_> = cut
                    .iter()
                    .map(|d| lod_support::scissor(d.clip, cx, cz, scale, width, height))
                    .collect();
                let mut encoder = device.create_command_encoder(&Default::default());
                {
                    let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                        label: None,
                        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                            view: &view,
                            depth_slice: None,
                            resolve_target: None,
                            ops: wgpu::Operations {
                                load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                                store: wgpu::StoreOp::Store,
                            },
                        })],
                        ..Default::default()
                    });
                    pass.set_pipeline(&pipeline);
                    pass.set_bind_group(0, &global, &[]);
                    for (group, scissor) in groups.iter().zip(&scissors) {
                        if let Some([x, z, w, h]) = scissor {
                            pass.set_scissor_rect(*x, *z, *w, *h);
                            pass.set_bind_group(1, group, &[]);
                            pass.draw(0..6, 0..1);
                        }
                    }
                }
                encoder.copy_texture_to_buffer(
                    texture.as_image_copy(),
                    wgpu::TexelCopyBufferInfo {
                        buffer: &output,
                        layout: wgpu::TexelCopyBufferLayout {
                            offset: 0,
                            bytes_per_row: Some(width * 4),
                            rows_per_image: Some(height),
                        },
                    },
                    texture.size(),
                );
                queue.submit([encoder.finish()]);
                let pixels = read(&device, &output);
                for z in 0..height {
                    for x in 0..width {
                        let source = scissors.iter().position(|s| {
                            s.is_some_and(|[sx, sz, w, h]| {
                                x >= sx && x < sx + w && z >= sz && z < sz + h
                            })
                        });
                        let expected = match source {
                            Some(1) => [0., 0., 0.5, 0.5],
                            Some(_) => [0.5, 0., 0., 0.5],
                            None => [0.; 4],
                        };
                        let offset = ((z * width + x) * 4) as usize;
                        near(&pixels[offset..offset + 4], expected);
                    }
                }
            }
        }
    });
}
