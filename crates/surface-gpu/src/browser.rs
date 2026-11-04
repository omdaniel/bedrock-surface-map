use crate::*;
use std::collections::BTreeMap;
use surface_core::lod::TileKey;
use wasm_bindgen::prelude::*;
use wgpu::util::DeviceExt;

fn js_error(e: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&e.to_string())
}
fn lod_key(level: u32, x: i32, z: i32) -> Result<TileKey, JsValue> {
    TileKey::new(u8::try_from(level).map_err(js_error)?, x, z).map_err(js_error)
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
pub fn decode_lod_surface(
    bytes: &[u8],
    level: u32,
    x: i32,
    z: i32,
    material_count: u32,
) -> Result<Vec<u32>, JsValue> {
    lod_support::decode_surface(bytes, lod_key(level, x, z)?, material_count).map_err(js_error)
}

#[wasm_bindgen]
pub fn decode_lod_height(bytes: &[u8], level: u32, x: i32, z: i32) -> Result<Vec<f32>, JsValue> {
    lod_support::decode_height(bytes, lod_key(level, x, z)?).map_err(js_error)
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
pub fn reduce_surface_words(
    words: &[u32],
    side: usize,
    stride: usize,
) -> Result<Vec<u32>, JsValue> {
    surface_core::reduction::reduce_words(words, side, stride).map_err(js_error)
}
#[wasm_bindgen]
pub fn decode_heights(bytes: &[u8], columns: usize) -> Result<Vec<f32>, JsValue> {
    decode_height_samples(bytes, columns, columns, 1)
}

#[wasm_bindgen]
pub fn decode_height_samples(
    bytes: &[u8],
    columns: usize,
    width: usize,
    stride: usize,
) -> Result<Vec<f32>, JsValue> {
    if columns > 16 * 1024 * 1024 {
        return Err(js_error("heightfield limit"));
    }
    if width == 0
        || !columns.is_multiple_of(width)
        || ![1, 2, 4].contains(&stride)
        || !width.is_multiple_of(stride)
        || !(columns / width).is_multiple_of(stride)
    {
        return Err(js_error("heightfield sample dimensions"));
    }
    let raw = surface_core::decompress(bytes, columns * 2).map_err(js_error)?;
    if raw.len() != columns * 2 {
        return Err(js_error("heightfield length mismatch"));
    }
    let mut out = Vec::with_capacity(columns / (stride * stride));
    for z in (0..columns / width).step_by(stride) {
        for x in (0..width).step_by(stride) {
            let mut sum = 0i32;
            let mut count = 0;
            for dz in 0..stride {
                for dx in 0..stride {
                    let i = ((z + dz) * width + x + dx) * 2;
                    let h = i16::from_le_bytes([raw[i], raw[i + 1]]);
                    if h != surface_core::MISSING_HEIGHT {
                        sum += i32::from(h);
                        count += 1;
                    }
                }
            }
            out.push(if count == 0 {
                -1e6
            } else {
                (sum as f32 / count as f32).round() / 16.
            });
        }
    }
    Ok(out)
}

struct Region {
    render: wgpu::BindGroup,
    overview_group: wgpu::BindGroup,
    mips: Vec<wgpu::BindGroup>,
    _data: wgpu::Buffer,
    _origin: wgpu::Buffer,
    texture: wgpu::Texture,
    words: usize,
    stride: usize,
    side: u32,
    world_origin: [f32; 2],
    dirty: std::cell::Cell<bool>,
    prepared: std::cell::Cell<bool>,
}

impl Region {
    fn bytes(&self) -> usize {
        lod_support::tile_bytes(self.words, self.side)
    }
    fn visible(&self, cx: f32, cz: f32, halfx: f32, halfz: f32) -> bool {
        let [x, z] = self.world_origin;
        let span = (self.side as usize * self.stride) as f32;
        x <= cx + halfx && x + span >= cx - halfx && z <= cz + halfz && z + span >= cz - halfz
    }
    fn destroy(self) {
        self._data.destroy();
        self._origin.destroy();
        self.texture.destroy();
    }
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
    lod_tiles: BTreeMap<TileKey, Region>,
    // None retains the legacy region API. Some(empty) is an explicit empty cut.
    lod_draw_tiles: Option<Vec<lod_support::DrawTile>>,
    sampler: wgpu::Sampler,
    base_bytes: usize,
    heights: height_field::HeightField,
    // Exact world bounds for page-to-sample mapping, separate from shader f32s.
    height_bounds: [i32; 4],
    height_dirty: bool,
    material_buffer: wgpu::Buffer,
    atlas_view: wgpu::TextureView,
    atlas_sampler: wgpu::Sampler,
    first_frame_requested: bool,
    lost: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

#[wasm_bindgen]
impl Renderer {
    #[allow(clippy::too_many_arguments)] // Flat WASM ABI keeps typed arrays out of serialized configuration.
    #[wasm_bindgen(js_name=create)]
    pub async fn create(
        canvas: web_sys::HtmlCanvasElement,
        bounds: Vec<i32>,
        heights: Vec<f32>,
        materials: Vec<f32>,
        rgba: Vec<u8>,
        aw: u32,
        ah: u32,
        stride: usize,
    ) -> Result<Renderer, JsValue> {
        console_error_panic_hook::set_once();
        if bounds.len() != 4
            || !materials.len().is_multiple_of(12)
            || materials.is_empty()
            || aw < 4
            || ah < 4
            || (aw as u64 * ah as u64).checked_mul(4) != Some(rgba.len() as u64)
            || materials.len() > 65536 * 12
            || !materials.iter().all(|v| v.is_finite())
        {
            return Err(js_error("invalid renderer input"));
        }
        let (w, h) =
            lod_support::height_dimensions(&bounds, stride, heights.len()).map_err(js_error)?;
        let base_bytes = height_field::HeightField::allocation_bytes(w, h).map_err(js_error)?
            + lod_support::mip_bytes(aw, ah, 3)
            + materials.len() * 4
            + 80;
        if base_bytes > lod_support::GPU_LIMIT {
            return Err(js_error("GPU cache limit exceeded"));
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
            stride as f32,
            0.,
        ];
        let params = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("camera"),
            contents: bytemuck::cast_slice(&values),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });
        let height_field =
            height_field::HeightField::new(&device, &queue, w, h, &heights).map_err(js_error)?;
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
                entry(4, &height_field.buffer),
            ],
        });
        let overview_pipeline =
            compute_pipeline(&device, "overview levels", OVERVIEW_SHADER, "overview");
        let mip_pipeline = compute_pipeline(&device, "overview filtering", MIP_SHADER, "mip");
        let global_overview = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &overview_pipeline.get_bind_group_layout(0),
            entries: &[
                entry(0, &params),
                entry(1, &mats),
                entry(2, &height_field.buffer),
            ],
        });
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
            lod_tiles: BTreeMap::new(),
            lod_draw_tiles: None,
            sampler,
            base_bytes,
            heights: height_field,
            height_bounds: bounds.as_slice().try_into().unwrap(),
            height_dirty: false,
            material_buffer: mats,
            atlas_view,
            atlas_sampler,
            first_frame_requested: false,
            lost,
        })
    }
    pub fn add_region(
        &mut self,
        rx: i32,
        rz: i32,
        words: Vec<u32>,
        stride: usize,
    ) -> Result<(), JsValue> {
        if ![1, 2, 4].contains(&stride)
            || words.len() != surface_core::CELLS * 8 / (stride * stride)
        {
            return Err(js_error("invalid region GPU data"));
        }
        let side = 256 / stride as u32;
        let old_bytes = self.regions.get(&(rx, rz)).map_or(0, Region::bytes);
        if self.gpu_bytes() as usize - old_bytes + lod_support::tile_bytes(words.len(), side)
            > lod_support::GPU_LIMIT
        {
            return Err(js_error("GPU cache limit exceeded"));
        }
        self.remove_region(rx, rz);
        let region = self.make_tile([rx as f32 * 256., rz as f32 * 256.], side, stride, &words);
        self.regions.insert((rx, rz), region);
        Ok(())
    }

    pub fn add_lod_tile(
        &mut self,
        level: u32,
        x: i32,
        z: i32,
        words: Vec<u32>,
    ) -> Result<(), JsValue> {
        let key = lod_key(level, x, z)?;
        let words =
            lod_support::pack_surface(key, words, (self.material_buffer.size() / 48) as u32)
                .map_err(js_error)?;
        if let Some(tile) = self.lod_tiles.get(&key) {
            // Same-size replacement keeps the last valid shaded texture resident.
            self.queue
                .write_buffer(&tile._data, 0, bytemuck::cast_slice(&words));
            tile.dirty.set(true);
            return Ok(());
        }
        if self.gpu_bytes() as usize + lod_support::tile_bytes(words.len(), 128)
            > lod_support::GPU_LIMIT
        {
            return Err(js_error("GPU cache limit exceeded"));
        }
        let [wx, wz, _, _] = key.bounds().map_err(js_error)?;
        let tile = self.make_tile([wx as f32, wz as f32], 128, 1usize << level, &words);
        self.lod_tiles.insert(key, tile);
        Ok(())
    }

    pub fn remove_lod_tile(&mut self, level: u32, x: i32, z: i32) {
        let Ok(key) = lod_key(level, x, z) else {
            return;
        };
        if let Some(tile) = self.lod_tiles.remove(&key) {
            tile.destroy();
        }
    }

    /// Activates LOD mode, including for an empty cut. Missing or unprepared
    /// residents are skipped; selection never implicitly uploads or shades.
    pub fn set_lod_draw_tiles(&mut self, triples: Vec<i32>) -> Result<(), JsValue> {
        self.lod_draw_tiles = Some(lod_support::draw_tiles(&triples).map_err(js_error)?);
        Ok(())
    }

    pub fn set_lod_draw_cut(&mut self, records: Vec<i32>) -> Result<(), JsValue> {
        self.lod_draw_tiles = Some(lod_support::draw_cut(&records).map_err(js_error)?);
        Ok(())
    }

    pub fn lod_pending_tiles(&self) -> u32 {
        self.lod_tiles
            .values()
            .filter(|tile| tile.dirty.get())
            .count() as u32
    }

    /// Whether this resident still needs shaded-texture preparation. Invalid or
    /// missing keys return false. This is independent of height eligibility;
    /// combine with lod_tile_ready to check whether a prepared tile is drawable.
    pub fn lod_tile_dirty(&self, level: u32, x: i32, z: i32) -> bool {
        let Ok(key) = lod_key(level, x, z) else {
            return false;
        };
        self.lod_tiles
            .get(&key)
            .is_some_and(|tile| tile.dirty.get())
    }

    /// Dirty-but-prepared tiles keep their previous shaded texture. The cut
    /// builder can use this to retain parent coverage while a child warms up.
    pub fn lod_tile_ready(&self, level: u32, x: i32, z: i32) -> bool {
        let Ok(key) = lod_key(level, x, z) else {
            return false;
        };
        !self.is_lost()
            && self.lod_height_ready(key)
            && self
                .lod_tiles
                .get(&key)
                .is_some_and(|tile| tile.prepared.get())
    }

    /// Uses the settings from the latest render call. Selected tiles have first
    /// priority, then other residents. Fine tiles wait for stride-one coverage.
    pub fn prepare_lod_tiles(&mut self, max_tiles: u32) -> u32 {
        if max_tiles == 0 || self.is_lost() {
            return self.lod_pending_tiles();
        }
        if self.height_dirty {
            self.heights.rebuild(&self.device, &self.queue);
            self.height_dirty = false;
        }
        self.queue
            .write_buffer(&self.params, 0, bytemuck::cast_slice(&self.values));
        let mut remaining = max_tiles;
        for selected in [true, false] {
            for (key, tile) in &self.lod_tiles {
                if remaining == 0 {
                    return self.lod_pending_tiles();
                }
                if self
                    .lod_draw_tiles
                    .as_ref()
                    .is_some_and(|cut| cut.iter().any(|draw| draw.key == *key))
                    != selected
                    || !tile.dirty.get()
                    || !self.lod_height_ready(*key)
                {
                    continue;
                }
                self.regenerate(tile);
                remaining -= 1;
            }
        }
        self.lod_pending_tiles()
    }
}

impl Renderer {
    fn lod_height_ready(&self, key: TileKey) -> bool {
        lod_support::fine_height_coverage(
            key,
            self.values[8..12].try_into().unwrap(),
            self.values[18],
        )
    }

    fn make_tile(&self, world_origin: [f32; 2], side: u32, stride: usize, words: &[u32]) -> Region {
        let mip_count = side.ilog2() + 1;
        let data = storage(&self.device, bytemuck::cast_slice(words));
        let origin = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: None,
                contents: bytemuck::cast_slice(&[
                    world_origin[0],
                    world_origin[1],
                    stride as f32,
                    side as f32,
                ]),
                usage: wgpu::BufferUsages::UNIFORM,
            });
        let texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("local GPU overview"),
            size: wgpu::Extent3d {
                width: side,
                height: side,
                depth_or_array_layers: 1,
            },
            mip_level_count: mip_count,
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
        for level in 1..mip_count {
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
        Region {
            render,
            overview_group,
            mips,
            _data: data,
            _origin: origin,
            texture,
            words: words.len(),
            stride,
            side,
            world_origin,
            dirty: std::cell::Cell::new(true),
            prepared: std::cell::Cell::new(false),
        }
    }
    fn regenerate(&self, r: &Region) {
        let mut encoder = self.device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_compute_pass(&Default::default());
            pass.set_pipeline(&self.overview_pipeline);
            pass.set_bind_group(0, &self.global_overview, &[]);
            pass.set_bind_group(1, &r.overview_group, &[]);
            let groups = r.side.div_ceil(8);
            pass.dispatch_workgroups(groups, groups, 1);
        }
        for (i, g) in r.mips.iter().enumerate() {
            let size = (r.side / 2) >> i;
            let mut pass = encoder.begin_compute_pass(&Default::default());
            pass.set_pipeline(&self.mip_pipeline);
            pass.set_bind_group(0, g, &[]);
            pass.dispatch_workgroups(size.div_ceil(8), size.div_ceil(8), 1);
        }
        self.queue.submit([encoder.finish()]);
        r.dirty.set(false);
        r.prepared.set(true);
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
                entry(4, &self.heights.buffer),
            ],
        });
        self.global_overview = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("updated overview resources"),
            layout: &self.overview_pipeline.get_bind_group_layout(0),
            entries: &[
                entry(0, &self.params),
                entry(1, &self.material_buffer),
                entry(2, &self.heights.buffer),
            ],
        });
    }
}

#[wasm_bindgen]
impl Renderer {
    pub fn cpu_bytes(&self) -> u32 {
        0
    }
    pub fn height_bytes(&self) -> u32 {
        self.heights.bytes() as u32
    }
    pub fn update_materials(&mut self, values: Vec<f32>) -> Result<(), JsValue> {
        if values.is_empty()
            || !values.len().is_multiple_of(12)
            || values.len() > 65536 * 12
            || !values.iter().all(|v| v.is_finite())
        {
            return Err(js_error("invalid catalog update"));
        }
        if self.gpu_bytes() as usize - self.material_buffer.size() as usize + values.len() * 4
            > lod_support::GPU_LIMIT
        {
            return Err(js_error("GPU cache limit exceeded"));
        }
        let buffer = storage(&self.device, bytemuck::cast_slice(&values));
        self.base_bytes = self.base_bytes - self.material_buffer.size() as usize + values.len() * 4;
        let old = std::mem::replace(&mut self.material_buffer, buffer);
        self.rebind();
        old.destroy();
        for r in self.regions.values().chain(self.lod_tiles.values()) {
            r.dirty.set(true);
        }
        Ok(())
    }
    pub fn set_height_window(
        &mut self,
        bounds: Vec<i32>,
        heights: Vec<f32>,
        stride: usize,
    ) -> Result<(), JsValue> {
        let (width, height) =
            lod_support::height_dimensions(&bounds, stride, heights.len()).map_err(js_error)?;
        if !heights.iter().all(|v| v.is_finite()) {
            return Err(js_error("height window size"));
        }
        let bytes = height_field::HeightField::allocation_bytes(width, height).map_err(js_error)?;
        if self.gpu_bytes() as usize - self.heights.bytes() + bytes > lod_support::GPU_LIMIT {
            return Err(js_error("GPU cache limit exceeded"));
        }
        let field =
            height_field::HeightField::new(&self.device, &self.queue, width, height, &heights)
                .map_err(js_error)?;
        self.base_bytes = self.base_bytes - self.heights.bytes() + field.bytes();
        let old = std::mem::replace(&mut self.heights, field);
        self.height_bounds = bounds.as_slice().try_into().unwrap();
        self.height_dirty = false;
        self.values[8..12].copy_from_slice(&[
            bounds[0] as f32,
            bounds[1] as f32,
            width as f32,
            height as f32,
        ]);
        self.values[18] = stride as f32;
        self.rebind();
        old.buffer.destroy();
        for r in self.regions.values().chain(self.lod_tiles.values()) {
            r.dirty.set(true);
        }
        Ok(())
    }
    /// Patch decoded 128x128 means at their native stride. Invalid input throws;
    /// a different stride, partial/outside page or shifted sample grid returns
    /// false without writes. The next render/prepare rebuilds the height tree.
    pub fn patch_lod_height(
        &mut self,
        level: u32,
        x: i32,
        z: i32,
        values: Vec<f32>,
    ) -> Result<bool, JsValue> {
        let key = lod_key(level, x, z)?;
        let Some([x, z]) = lod_support::height_patch_origin(
            key,
            self.height_bounds,
            self.values[18] as usize,
            &values,
        )
        .map_err(js_error)?
        else {
            return Ok(false);
        };
        self.heights
            .patch(&self.queue, x, z, 128, 128, &values)
            .map_err(js_error)?;
        self.height_dirty = true;
        for tile in self.regions.values().chain(self.lod_tiles.values()) {
            tile.dirty.set(true);
        }
        Ok(true)
    }
    pub fn patch_height_region(
        &mut self,
        rx: i32,
        rz: i32,
        values: Vec<f32>,
    ) -> Result<(), JsValue> {
        let stride = self.values[18] as i32;
        if ![1, 2, 4].contains(&stride) {
            return Err(js_error("legacy height patches require stride 1, 2 or 4"));
        }
        let side = 256 / stride;
        let x = (rx * 256 - self.values[8] as i32) / stride;
        let z = (rz * 256 - self.values[9] as i32) / stride;
        if x < 0 || z < 0 || x + side > self.values[10] as i32 || z + side > self.values[11] as i32
        {
            return Ok(());
        }
        self.heights
            .patch(
                &self.queue,
                x as usize,
                z as usize,
                side as usize,
                side as usize,
                &values,
            )
            .map_err(js_error)?;
        self.height_dirty = true;
        for r in self.regions.values().chain(self.lod_tiles.values()) {
            r.dirty.set(true);
        }
        Ok(())
    }
    pub fn patch_chunk(&mut self, cx: i32, cz: i32, words: Vec<u32>) -> Result<(), JsValue> {
        let r = self
            .regions
            .get(&(cx.div_euclid(16), cz.div_euclid(16)))
            .ok_or_else(|| js_error("region not resident"))?;
        let side = 16 / r.stride;
        if words.len() != side * side * 8 {
            return Err(js_error("invalid chunk GPU data"));
        }
        let x = cx.rem_euclid(16) as usize * side;
        let z = cz.rem_euclid(16) as usize * side;
        for row in 0..side {
            self.queue.write_buffer(
                &r._data,
                (((z + row) * (256 / r.stride) + x) * 32) as u64,
                bytemuck::cast_slice(&words[row * side * 8..(row + 1) * side * 8]),
            );
        }
        r.dirty.set(true);
        Ok(())
    }
    pub fn remove_region(&mut self, rx: i32, rz: i32) {
        if let Some(r) = self.regions.remove(&(rx, rz)) {
            r.destroy();
        }
    }
    pub fn gpu_bytes(&self) -> u32 {
        (self.base_bytes
            + self
                .regions
                .values()
                .chain(self.lod_tiles.values())
                .map(Region::bytes)
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
        if self.height_dirty {
            self.heights.rebuild(&self.device, &self.queue);
            self.height_dirty = false;
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
            for r in self.regions.values().chain(self.lod_tiles.values()) {
                r.dirty.set(true);
            }
        }
        if self.lod_draw_tiles.is_none() {
            for r in self.regions.values() {
                if r.dirty.get()
                    && r.visible(
                        cx,
                        cz,
                        width as f32 / scale / 2.,
                        height as f32 / scale / 2.,
                    )
                {
                    self.regenerate(r);
                }
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
            if let Some(cut) = &self.lod_draw_tiles {
                for draw in cut {
                    let Some(r) = self.lod_tiles.get(&draw.key) else {
                        continue;
                    };
                    if !r.prepared.get()
                        || !self.lod_height_ready(draw.key)
                        || !r.visible(cx, cz, halfx, halfz)
                    {
                        continue;
                    }
                    let Some([x, y, w, h]) =
                        lod_support::scissor(draw.clip, cx, cz, scale, width, height)
                    else {
                        continue;
                    };
                    pass.set_scissor_rect(x, y, w, h);
                    pass.set_bind_group(1, &r.render, &[]);
                    pass.draw(0..6, 0..1);
                    drew_region = true;
                }
            } else {
                for r in self.regions.values() {
                    if !r.prepared.get() || !r.visible(cx, cz, halfx, halfz) {
                        continue;
                    }
                    pass.set_bind_group(1, &r.render, &[]);
                    pass.draw(0..6, 0..1);
                    drew_region = true;
                }
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
