use crate::*;
use std::collections::BTreeMap;
use wasm_bindgen::prelude::*;
use wgpu::util::DeviceExt;

fn js_error(e: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&e.to_string())
}
fn storage(device: &wgpu::Device, bytes: &[u8]) -> wgpu::Buffer {
    device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("map data"),
        contents: bytes,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
    })
}
fn entry(binding: u32, buffer: &wgpu::Buffer) -> wgpu::BindGroupEntry<'_> {
    wgpu::BindGroupEntry {
        binding,
        resource: buffer.as_entire_binding(),
    }
}

#[wasm_bindgen]
pub fn decode_chunk_words(
    bytes: &[u8],
    cx: i32,
    cz: i32,
    material_count: u32,
) -> Result<Vec<u32>, JsValue> {
    let raw = surface_core::decompress(bytes, 32768).map_err(js_error)?;
    let chunk = surface_core::terrain::SurfaceChunk::decode(&raw).map_err(js_error)?;
    chunk
        .validate(material_count as usize, false)
        .map_err(js_error)?;
    if chunk.cx != cx || chunk.cz != cz {
        return Err(js_error("chunk coordinates mismatch"));
    }
    Ok(chunk
        .columns
        .iter()
        .flat_map(|c| {
            [
                c[1] as u32,
                c[2] as u32,
                c[3] as u32,
                c[5] as u32,
                c[7] as u32,
                c[8] as u32,
                c[6] as u32,
                c[0] as u32,
            ]
        })
        .collect())
}

#[wasm_bindgen]
pub fn decode_region_words(
    bytes: &[u8],
    rx: i32,
    rz: i32,
    material_count: u32,
) -> Result<Vec<u32>, JsValue> {
    let raw = surface_core::decompress(bytes, surface_core::MAX_DECOMPRESSED).map_err(js_error)?;
    let r = surface_core::decode_region(&raw).map_err(js_error)?;
    if r.rx != rx
        || r.rz != rz
        || r.materials
            .iter()
            .chain(&r.overlays)
            .chain(&r.supports)
            .any(|id| *id >= material_count)
    {
        return Err(js_error("region coordinates or material IDs invalid"));
    }
    Ok(r.gpu_words())
}
#[wasm_bindgen]
pub fn decode_heights(bytes: &[u8], columns: usize) -> Result<Vec<f32>, JsValue> {
    if columns > 16 * 1024 * 1024 {
        return Err(js_error("heightfield limit"));
    }
    let raw = surface_core::decompress(bytes, columns * 2).map_err(js_error)?;
    if raw.len() != columns * 2 {
        return Err(js_error("heightfield length mismatch"));
    }
    Ok(raw
        .chunks_exact(2)
        .map(|b| {
            let h = i16::from_le_bytes([b[0], b[1]]);
            if h == surface_core::MISSING_HEIGHT {
                -1e6
            } else {
                h as f32 / 16.
            }
        })
        .collect())
}

struct Region {
    render: wgpu::BindGroup,
    overview_group: wgpu::BindGroup,
    mips: Vec<wgpu::BindGroup>,
    _data: wgpu::Buffer,
    _origin: wgpu::Buffer,
    texture: wgpu::Texture,
    words: usize,
    dirty: std::cell::Cell<bool>,
}

#[wasm_bindgen]
pub struct Renderer {
    device: wgpu::Device,
    queue: wgpu::Queue,
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    render_pipeline: wgpu::RenderPipeline,
    overview_pipeline: wgpu::ComputePipeline,
    mip_pipeline: wgpu::ComputePipeline,
    global_render: wgpu::BindGroup,
    global_overview: wgpu::BindGroup,
    params: wgpu::Buffer,
    values: [f32; 20],
    regions: BTreeMap<(i32, i32), Region>,
    sampler: wgpu::Sampler,
    base_bytes: usize,
    height_buffer: wgpu::Buffer,
    height_tree: Vec<u32>,
    material_buffer: wgpu::Buffer,
    atlas_view: wgpu::TextureView,
    atlas_sampler: wgpu::Sampler,
    first_frame_requested: bool,
    lost: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

#[wasm_bindgen]
impl Renderer {
    #[wasm_bindgen(js_name=create)]
    pub async fn create(
        canvas: web_sys::HtmlCanvasElement,
        bounds: Vec<i32>,
        heights: Vec<f32>,
        materials: Vec<f32>,
        rgba: Vec<u8>,
        aw: u32,
        ah: u32,
    ) -> Result<Renderer, JsValue> {
        console_error_panic_hook::set_once();
        if bounds.len() != 4
            || !materials.len().is_multiple_of(12)
            || materials.is_empty()
            || rgba.len() != aw as usize * ah as usize * 4
        {
            return Err(js_error("invalid renderer input"));
        }
        let w = (bounds[2] - bounds[0]) as usize;
        let h = (bounds[3] - bounds[1]) as usize;
        if w == 0 || h == 0 || heights.len() != w * h || w * h > 16 * 1024 * 1024 {
            return Err(js_error("invalid heightfield dimensions"));
        }
        let instance = wgpu::Instance::default();
        let surface = instance
            .create_surface(wgpu::SurfaceTarget::Canvas(canvas))
            .map_err(js_error)?;
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                compatible_surface: Some(&surface),
                ..Default::default()
            })
            .await
            .map_err(js_error)?;
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("Bedrock surface renderer"),
                ..Default::default()
            })
            .await
            .map_err(js_error)?;
        let lost = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = lost.clone();
        device.set_device_lost_callback(move |_, message| {
            flag.store(true, std::sync::atomic::Ordering::Relaxed);
            web_sys::console::error_1(&js_error(format!("GPU device lost: {message}")));
            if let (Some(window), Ok(event)) = (
                web_sys::window(),
                web_sys::Event::new("surface-device-lost"),
            ) {
                let _ = window.dispatch_event(&event);
            }
        });
        let caps = surface.get_capabilities(&adapter);
        let format = caps
            .formats
            .iter()
            .copied()
            .find(|f| !f.is_srgb())
            .unwrap_or(caps.formats[0]);
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            color_space: wgpu::SurfaceColorSpace::Auto,
            width: 1,
            height: 1,
            present_mode: wgpu::PresentMode::Fifo,
            desired_maximum_frame_latency: 2,
            alpha_mode: wgpu::CompositeAlphaMode::Opaque,
            view_formats: vec![],
        };
        surface.configure(&device, &config);
        let direction = surface_core::sun_direction(330.);
        let values = [
            0.,
            0.,
            1.,
            1.,
            1.,
            1.,
            1.,
            1.,
            bounds[0] as f32,
            bounds[1] as f32,
            w as f32,
            h as f32,
            0.55,
            1.,
            direction[0],
            direction[1],
            1.,
            0.25,
            0.,
            0.,
        ];
        let params = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("camera"),
            contents: bytemuck::cast_slice(&values),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });
        let tree = surface_core::height_pyramid(&heights, w, h);
        let ss = storage(&device, bytemuck::cast_slice(&tree));
        let mats = storage(&device, bytemuck::cast_slice(&materials));
        let atlas = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("shared material atlas"),
            size: wgpu::Extent3d {
                width: aw,
                height: ah,
                depth_or_array_layers: 1,
            },
            mip_level_count: 3,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        queue.write_texture(
            atlas.as_image_copy(),
            &rgba,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(aw * 4),
                rows_per_image: Some(ah),
            },
            atlas.size(),
        );
        // Two filtered mip levels preserve at least one texel of padding per tile.
        let mut pixels = rgba.clone();
        let mut mw = aw;
        let mut mh = ah;
        for level in 1..=2 {
            let nw = mw / 2;
            let nh = mh / 2;
            let mut next = vec![0u8; (nw * nh * 4) as usize];
            for y in 0..nh {
                for x in 0..nw {
                    for c in 0..4 {
                        let mut sum = 0u32;
                        for dy in 0..2 {
                            for dx in 0..2 {
                                sum += pixels[(((y * 2 + dy) * mw + x * 2 + dx) * 4 + c) as usize]
                                    as u32;
                            }
                        }
                        next[((y * nw + x) * 4 + c) as usize] = (sum / 4) as u8;
                    }
                }
            }
            let mut target = atlas.as_image_copy();
            target.mip_level = level;
            queue.write_texture(
                target,
                &next,
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(nw * 4),
                    rows_per_image: Some(nh),
                },
                wgpu::Extent3d {
                    width: nw,
                    height: nh,
                    depth_or_array_layers: 1,
                },
            );
            pixels = next;
            mw = nw;
            mh = nh;
        }
        let atlas_view = atlas.create_view(&Default::default());
        let atlas_sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            mag_filter: wgpu::FilterMode::Nearest,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::MipmapFilterMode::Linear,
            ..Default::default()
        });
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::MipmapFilterMode::Linear,
            ..Default::default()
        });
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("terrain"),
            source: wgpu::ShaderSource::Wgsl(TERRAIN_SHADER.into()),
        });
        let render_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("surface terrain"),
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
                targets: &[Some(wgpu::ColorTargetState {
                    format,
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
        let global_render = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &render_pipeline.get_bind_group_layout(0),
            entries: &[
                entry(0, &params),
                entry(1, &mats),
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(&atlas_view),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::Sampler(&atlas_sampler),
                },
                entry(4, &ss),
            ],
        });
        let overview_pipeline =
            compute_pipeline(&device, "overview levels", OVERVIEW_SHADER, "overview");
        let mip_pipeline = compute_pipeline(&device, "overview filtering", MIP_SHADER, "mip");
        let global_overview = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &overview_pipeline.get_bind_group_layout(0),
            entries: &[entry(0, &params), entry(1, &mats), entry(2, &ss)],
        });
        let base_bytes = tree.len() * 4 + rgba.len() * 21 / 16 + materials.len() * 4;
        Ok(Self {
            device,
            queue,
            surface,
            config,
            render_pipeline,
            overview_pipeline,
            mip_pipeline,
            global_render,
            global_overview,
            params,
            values,
            regions: BTreeMap::new(),
            sampler,
            base_bytes,
            height_buffer: ss,
            height_tree: tree,
            material_buffer: mats,
            atlas_view,
            atlas_sampler,
            first_frame_requested: false,
            lost,
        })
    }
    pub fn add_region(&mut self, rx: i32, rz: i32, words: Vec<u32>) -> Result<(), JsValue> {
        if words.len() != surface_core::CELLS * 8 {
            return Err(js_error("invalid region GPU data"));
        }
        self.remove_region(rx, rz);
        let cost = words.len() * 4 + 349524;
        if self.gpu_bytes() as usize + cost > 256 * 1024 * 1024 {
            return Err(js_error("GPU cache limit exceeded"));
        }
        let data = storage(&self.device, bytemuck::cast_slice(&words));
        let origin = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: None,
                contents: bytemuck::cast_slice(&[rx as f32 * 256., rz as f32 * 256., 0., 0.]),
                usage: wgpu::BufferUsages::UNIFORM,
            });
        let texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("local GPU overview"),
            size: wgpu::Extent3d {
                width: 256,
                height: 256,
                depth_or_array_layers: 1,
            },
            mip_level_count: 9,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::STORAGE_BINDING,
            view_formats: &[],
        });
        let all = texture.create_view(&Default::default());
        let first = texture.create_view(&wgpu::TextureViewDescriptor {
            base_mip_level: 0,
            mip_level_count: Some(1),
            ..Default::default()
        });
        let render = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &self.render_pipeline.get_bind_group_layout(1),
            entries: &[
                entry(0, &data),
                entry(1, &origin),
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(&all),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
            ],
        });
        let overview_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &self.overview_pipeline.get_bind_group_layout(1),
            entries: &[
                entry(0, &data),
                entry(1, &origin),
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(&first),
                },
            ],
        });
        let mut mips = vec![];
        for level in 1..9 {
            let src = texture.create_view(&wgpu::TextureViewDescriptor {
                base_mip_level: level - 1,
                mip_level_count: Some(1),
                ..Default::default()
            });
            let dst = texture.create_view(&wgpu::TextureViewDescriptor {
                base_mip_level: level,
                mip_level_count: Some(1),
                ..Default::default()
            });
            mips.push(self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: None,
                layout: &self.mip_pipeline.get_bind_group_layout(0),
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(&src),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::TextureView(&dst),
                    },
                ],
            }));
        }
        let region = Region {
            render,
            overview_group,
            mips,
            _data: data,
            _origin: origin,
            texture,
            words: words.len(),
            dirty: std::cell::Cell::new(true),
        };
        self.regenerate(&region);
        self.regions.insert((rx, rz), region);
        Ok(())
    }
    fn regenerate(&self, r: &Region) {
        let mut encoder = self.device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_compute_pass(&Default::default());
            pass.set_pipeline(&self.overview_pipeline);
            pass.set_bind_group(0, &self.global_overview, &[]);
            pass.set_bind_group(1, &r.overview_group, &[]);
            pass.dispatch_workgroups(32, 32, 1);
        }
        for (i, g) in r.mips.iter().enumerate() {
            let size = 128u32 >> i;
            let mut pass = encoder.begin_compute_pass(&Default::default());
            pass.set_pipeline(&self.mip_pipeline);
            pass.set_bind_group(0, g, &[]);
            pass.dispatch_workgroups(size.div_ceil(8), size.div_ceil(8), 1);
        }
        self.queue.submit([encoder.finish()]);
        r.dirty.set(false);
    }

    fn rebind(&mut self) {
        self.global_render = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("updated map resources"),
            layout: &self.render_pipeline.get_bind_group_layout(0),
            entries: &[
                entry(0, &self.params),
                entry(1, &self.material_buffer),
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(&self.atlas_view),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::Sampler(&self.atlas_sampler),
                },
                entry(4, &self.height_buffer),
            ],
        });
        self.global_overview = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("updated overview resources"),
            layout: &self.overview_pipeline.get_bind_group_layout(0),
            entries: &[
                entry(0, &self.params),
                entry(1, &self.material_buffer),
                entry(2, &self.height_buffer),
            ],
        });
    }
    pub fn cpu_bytes(&self) -> u32 {
        (self.height_tree.len() * 4) as u32
    }
    pub fn update_materials(&mut self, values: Vec<f32>) -> Result<(), JsValue> {
        if values.is_empty()
            || !values.len().is_multiple_of(12)
            || values.len() > 65536 * 12
            || !values.iter().all(|v| v.is_finite())
        {
            return Err(js_error("invalid catalog update"));
        }
        let buffer = storage(&self.device, bytemuck::cast_slice(&values));
        self.base_bytes = self.base_bytes - self.material_buffer.size() as usize + values.len() * 4;
        let old = std::mem::replace(&mut self.material_buffer, buffer);
        self.rebind();
        old.destroy();
        for r in self.regions.values() {
            r.dirty.set(true);
        }
        Ok(())
    }
    pub fn set_height_window(
        &mut self,
        bounds: Vec<i32>,
        heights: Vec<f32>,
    ) -> Result<(), JsValue> {
        if bounds.len() != 4 {
            return Err(js_error("height window bounds"));
        }
        let (width, height) = (
            (bounds[2] - bounds[0]) as usize,
            (bounds[3] - bounds[1]) as usize,
        );
        if width == 0
            || height == 0
            || width.checked_mul(height) != Some(heights.len())
            || heights.len() > 16 * 1024 * 1024
            || !heights.iter().all(|v| v.is_finite())
        {
            return Err(js_error("height window size"));
        }
        let tree = surface_core::height_pyramid(&heights, width, height);
        if self.gpu_bytes() as usize - self.height_tree.len() * 4 + tree.len() * 8
            > 256 * 1024 * 1024
        {
            return Err(js_error("Height coverage exceeds cache; zoom in"));
        }
        let buffer = storage(&self.device, bytemuck::cast_slice(&tree));
        self.base_bytes = self.base_bytes - self.height_tree.len() * 4 + tree.len() * 4;
        self.height_tree = tree;
        let old = std::mem::replace(&mut self.height_buffer, buffer);
        self.values[8..12].copy_from_slice(&[
            bounds[0] as f32,
            bounds[1] as f32,
            width as f32,
            height as f32,
        ]);
        self.rebind();
        old.destroy();
        for r in self.regions.values() {
            r.dirty.set(true);
        }
        Ok(())
    }
    pub fn patch_height_region(
        &mut self,
        rx: i32,
        rz: i32,
        values: Vec<f32>,
    ) -> Result<(), JsValue> {
        let x = rx * 256 - self.values[8] as i32;
        let z = rz * 256 - self.values[9] as i32;
        if x < 0 || z < 0 || x + 256 > self.values[10] as i32 || z + 256 > self.values[11] as i32 {
            return Ok(());
        }
        let ranges = surface_core::terrain::patch_height_tree(
            &mut self.height_tree,
            x as usize,
            z as usize,
            256,
            256,
            &values,
        )
        .map_err(js_error)?;
        for (start, count) in ranges {
            self.queue.write_buffer(
                &self.height_buffer,
                (start * 4) as u64,
                bytemuck::cast_slice(&self.height_tree[start..start + count]),
            );
        }
        for r in self.regions.values() {
            r.dirty.set(true);
        }
        Ok(())
    }
    pub fn patch_chunk(&mut self, cx: i32, cz: i32, words: Vec<u32>) -> Result<(), JsValue> {
        if words.len() != 256 * 8 {
            return Err(js_error("invalid chunk GPU data"));
        }
        let r = self
            .regions
            .get(&(cx.div_euclid(16), cz.div_euclid(16)))
            .ok_or_else(|| js_error("region not resident"))?;
        let x = cx.rem_euclid(16) as usize * 16;
        let z = cz.rem_euclid(16) as usize * 16;
        for row in 0..16 {
            self.queue.write_buffer(
                &r._data,
                (((z + row) * 256 + x) * 32) as u64,
                bytemuck::cast_slice(&words[row * 128..(row + 1) * 128]),
            );
        }
        r.dirty.set(true);
        Ok(())
    }
    pub fn remove_region(&mut self, rx: i32, rz: i32) {
        if let Some(r) = self.regions.remove(&(rx, rz)) {
            r._data.destroy();
            r.texture.destroy();
        }
    }
    pub fn gpu_bytes(&self) -> u32 {
        (self.base_bytes
            + self
                .regions
                .values()
                .map(|r| r.words * 4 + 349524)
                .sum::<usize>()) as u32
    }
    pub fn is_lost(&self) -> bool {
        self.lost.load(std::sync::atomic::Ordering::Relaxed)
    }
    pub fn simulate_device_loss(&self) {
        self.device.destroy();
    }
    #[allow(clippy::too_many_arguments)] // Flat WASM ABI avoids per-frame object serialization.
    pub fn render(
        &mut self,
        cx: f32,
        cz: f32,
        scale: f32,
        width: u32,
        height: u32,
        grid: bool,
        shadows: bool,
        elevation: f32,
        azimuth_degrees: f32,
        shadow_strength: f32,
        vivid: bool,
        relief_strength: f32,
        relief_width: f32,
    ) -> Result<bool, JsValue> {
        if self.is_lost() {
            return Err(js_error("GPU device lost; reload the map"));
        }
        if width == 0 || height == 0 {
            return Ok(false);
        }
        if !elevation.is_finite()
            || !(15.0..=75.0).contains(&elevation)
            || !azimuth_degrees.is_finite()
            || !(0.0..=360.0).contains(&azimuth_degrees)
            || !shadow_strength.is_finite()
            || !(0.0..=0.8).contains(&shadow_strength)
            || !relief_strength.is_finite()
            || !(0.0..=1.0).contains(&relief_strength)
            || !relief_width.is_finite()
            || !(0.05..=0.5).contains(&relief_width)
        {
            return Err(js_error("invalid lighting settings"));
        }
        if self.config.width != width || self.config.height != height {
            self.config.width = width;
            self.config.height = height;
            self.surface.configure(&self.device, &self.config);
        }
        let slope = elevation.to_radians().tan();
        let direction = surface_core::sun_direction(azimuth_degrees);
        let sun_changed = self.values[7] != slope || self.values[14..16] != direction;
        let changed = sun_changed
            || self.values[6] != (shadows as u32 as f32)
            || self.values[12] != shadow_strength
            || self.values[13] != vivid as u32 as f32
            || self.values[16] != relief_strength
            || self.values[17] != relief_width;
        self.values[..8].copy_from_slice(&[
            cx,
            cz,
            scale,
            width as f32,
            height as f32,
            grid as u32 as f32,
            shadows as u32 as f32,
            slope,
        ]);
        self.values[12] = shadow_strength;
        self.values[13] = vivid as u32 as f32;
        self.values[14..16].copy_from_slice(&direction);
        self.values[16] = relief_strength;
        self.values[17] = relief_width;
        self.queue
            .write_buffer(&self.params, 0, bytemuck::cast_slice(&self.values));
        if changed {
            for r in self.regions.values() {
                r.dirty.set(true);
            }
        }
        for ((rx, rz), r) in &self.regions {
            let x = *rx as f32 * 256.;
            let z = *rz as f32 * 256.;
            if r.dirty.get()
                && x <= cx + width as f32 / scale / 2.
                && x + 256. >= cx - width as f32 / scale / 2.
                && z <= cz + height as f32 / scale / 2.
                && z + 256. >= cz - height as f32 / scale / 2.
            {
                self.regenerate(r);
            }
        }
        let frame = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(t)
            | wgpu::CurrentSurfaceTexture::Suboptimal(t) => t,
            wgpu::CurrentSurfaceTexture::Timeout | wgpu::CurrentSurfaceTexture::Occluded => {
                return Ok(false);
            }
            wgpu::CurrentSurfaceTexture::Outdated => {
                self.surface.configure(&self.device, &self.config);
                return Ok(false);
            }
            _ => return Err(js_error("GPU surface unavailable; reload the map")),
        };
        let view = frame.texture.create_view(&Default::default());
        let mut encoder = self.device.create_command_encoder(&Default::default());
        let mut drew_region = false;
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("map"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color {
                            r: 0.075,
                            g: 0.09,
                            b: 0.09,
                            a: 1.,
                        }),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                ..Default::default()
            });
            pass.set_pipeline(&self.render_pipeline);
            pass.set_bind_group(0, &self.global_render, &[]);
            let halfx = width as f32 / scale / 2.;
            let halfz = height as f32 / scale / 2.;
            for ((rx, rz), r) in &self.regions {
                let x = *rx as f32 * 256.;
                let z = *rz as f32 * 256.;
                if x > cx + halfx
                    || x + 256. < cx - halfx
                    || z > cz + halfz
                    || z + 256. < cz - halfz
                {
                    continue;
                }
                pass.set_bind_group(1, &r.render, &[]);
                pass.draw(0..6, 0..1);
                drew_region = true;
            }
        }
        self.queue.submit([encoder.finish()]);
        self.queue.present(frame);
        if drew_region && !self.first_frame_requested {
            self.first_frame_requested = true;
            self.queue.on_submitted_work_done(|| {
                if let (Some(window), Ok(event)) = (
                    web_sys::window(),
                    web_sys::Event::new("surface-frame-ready"),
                ) {
                    let _ = window.dispatch_event(&event);
                }
            });
        }
        Ok(true)
    }
}
