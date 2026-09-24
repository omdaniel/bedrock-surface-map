use crate::lod::{CutEntry, GpuLod, Key, MAX_TILES};
use wasm_bindgen::prelude::*;

fn js_error(e: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&e.to_string())
}

#[wasm_bindgen]
pub struct LodRenderer {
    gpu: GpuLod,
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    lost: std::sync::Arc<std::sync::atomic::AtomicBool>,
    active: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

#[wasm_bindgen]
impl LodRenderer {
    #[wasm_bindgen(js_name = create)]
    pub async fn create(
        canvas: web_sys::HtmlCanvasElement,
        materials: js_sys::Float32Array,
        atlas: web_sys::ImageBitmap,
    ) -> Result<LodRenderer, JsValue> {
        console_error_panic_hook::set_once();
        if materials.length() == 0
            || !materials.length().is_multiple_of(12)
            || materials.length() > 65536 * 12
        {
            return Err(js_error("invalid LOD material catalog"));
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
                label: Some("Bedrock paged LOD renderer"),
                ..Default::default()
            })
            .await
            .map_err(js_error)?;
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
        let width = atlas.width();
        let height = atlas.height();
        if width < 4
            || height < 4
            || width > device.limits().max_texture_dimension_2d
            || height > device.limits().max_texture_dimension_2d
            || width as u64 * height as u64 * 21 / 4 > 64 * 1024 * 1024
        {
            return Err(js_error("invalid or oversized LOD atlas"));
        }
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("LOD external material atlas"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 3,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::COPY_DST
                | wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::STORAGE_BINDING
                | wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        });
        queue.copy_external_image_to_texture(
            &wgpu::CopyExternalImageSourceInfo {
                source: wgpu::ExternalImageSource::ImageBitmap(atlas),
                origin: wgpu::Origin2d::ZERO,
                flip_y: false,
            },
            wgpu::CopyExternalImageDestInfo {
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
                color_space: wgpu::PredefinedColorSpace::Srgb,
                premultiplied_alpha: false,
            },
            texture.size(),
        );
        let gpu =
            GpuLod::new(device, queue, format, &materials.to_vec(), texture).map_err(js_error)?;
        let lost = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let active = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
        let flag = lost.clone();
        let callback_active = active.clone();
        // Register only after successful construction, so a failed create cannot
        // dispatch a delayed loss event into the controller's next renderer.
        gpu.device.set_device_lost_callback(move |_, message| {
            if !callback_active.load(std::sync::atomic::Ordering::Acquire) {
                return;
            }
            flag.store(true, std::sync::atomic::Ordering::Relaxed);
            web_sys::console::error_1(&js_error(format!("LOD GPU device lost: {message}")));
            if let (Some(window), Ok(event)) = (
                web_sys::window(),
                web_sys::Event::new("surface-device-lost"),
            ) {
                let _ = window.dispatch_event(&event);
            }
        });
        Ok(Self {
            gpu,
            surface,
            config,
            lost,
            active,
        })
    }
    pub fn add_tile(
        &mut self,
        level: u32,
        x: i32,
        z: i32,
        words: js_sys::Uint32Array,
    ) -> Result<(), JsValue> {
        self.ensure_active()?;
        let key = Key::new(level, x, z).map_err(js_error)?;
        let stride = if level == 0 { 8 } else { 6 };
        if words.length() != 128 * 128 * stride {
            return Err(js_error("LOD tile word count mismatch"));
        }
        self.gpu.add_tile(key, words.to_vec()).map_err(js_error)
    }
    pub fn add_height(
        &mut self,
        level: u32,
        x: i32,
        z: i32,
        words: js_sys::Uint32Array,
    ) -> Result<(), JsValue> {
        self.ensure_active()?;
        let key = Key::new(level, x, z).map_err(js_error)?;
        let stride = if level == 0 { 1 } else { 2 };
        if words.length() != 128 * 128 * stride {
            return Err(js_error("LOD height word count mismatch"));
        }
        self.gpu.add_height(key, words.to_vec()).map_err(js_error)
    }
    pub fn remove_tile(&mut self, level: u32, x: i32, z: i32) -> Result<(), JsValue> {
        self.gpu
            .remove_tile(Key::new(level, x, z).map_err(js_error)?);
        Ok(())
    }
    pub fn remove_height(&mut self, level: u32, x: i32, z: i32) -> Result<(), JsValue> {
        self.gpu
            .remove_height(Key::new(level, x, z).map_err(js_error)?);
        Ok(())
    }
    pub fn has_tile(&self, level: u32, x: i32, z: i32) -> bool {
        Key::new(level, x, z).is_ok_and(|key| self.gpu.has_tile(key))
    }
    pub fn has_height(&self, level: u32, x: i32, z: i32) -> bool {
        Key::new(level, x, z).is_ok_and(|key| self.gpu.has_height(key))
    }
    pub fn set_world(
        &mut self,
        bounds: js_sys::Int32Array,
        height_max: i32,
    ) -> Result<(), JsValue> {
        self.ensure_active()?;
        if bounds.length() != 4 {
            return Err(js_error("LOD world requires four bounds"));
        }
        let mut values = [0; 4];
        bounds.copy_to(&mut values);
        self.gpu.set_world(values, height_max).map_err(js_error)
    }
    pub fn set_cut(&mut self, entries: js_sys::Float32Array) -> Result<(), JsValue> {
        self.ensure_active()?;
        if !entries.length().is_multiple_of(4) || entries.length() as usize > MAX_TILES * 4 {
            return Err(js_error("LOD cut length mismatch"));
        }
        let values = entries.to_vec();
        let mut cut = Vec::with_capacity(values.len() / 4);
        for e in values.chunks_exact(4) {
            if e[..3].iter().any(|v| !v.is_finite() || v.fract() != 0.)
                || !(0.0..=16.0).contains(&e[0])
                || e[1].abs() > 16777216.
                || e[2].abs() > 16777216.
            {
                return Err(js_error(
                    "cut keys must be exactly representable Float32 integers",
                ));
            }
            cut.push(CutEntry {
                key: Key::new(e[0] as u32, e[1] as i32, e[2] as i32).map_err(js_error)?,
                opacity: e[3],
            });
        }
        self.gpu.set_cut(cut).map_err(js_error)
    }
    pub fn set_materials(&mut self, values: js_sys::Float32Array) -> Result<(), JsValue> {
        self.ensure_active()?;
        if values.length() > 65536 * 12 {
            return Err(js_error("LOD catalog exceeds limit"));
        }
        self.gpu.set_materials(&values.to_vec()).map_err(js_error)
    }
    pub fn update_materials(
        &mut self,
        start: u32,
        values: js_sys::Float32Array,
    ) -> Result<(), JsValue> {
        self.ensure_active()?;
        if values.length() > 65536 * 12 {
            return Err(js_error("LOD catalog exceeds limit"));
        }
        self.gpu
            .update_materials(start, &values.to_vec())
            .map_err(js_error)
    }
    pub fn gpu_bytes(&self) -> f64 {
        self.gpu.gpu_bytes() as f64
    }
    /// [total, retiring, tiles, height arena, presentation, other shared].
    pub fn allocation_stats(&self) -> Vec<f64> {
        self.gpu
            .allocation_bytes()
            .into_iter()
            .map(|n| n as f64)
            .collect()
    }
    pub fn cpu_bytes(&self) -> f64 {
        self.gpu.cpu_bytes() as f64
    }
    pub fn retiring_bytes(&self) -> f64 {
        self.gpu.retiring_bytes() as f64
    }
    pub fn retiring_height_slots(&self) -> u32 {
        self.gpu.retiring_height_slots() as u32
    }
    pub fn pending_submissions(&self) -> u32 {
        self.gpu.pending_submissions() as u32
    }
    pub fn pending_tiles(&self) -> u32 {
        self.gpu.pending_tiles() as u32
    }
    pub fn pending_uploads(&self) -> u32 {
        self.gpu.pending_uploads() as u32
    }
    pub fn pending_preparations(&self) -> u32 {
        self.gpu.pending_preparations() as u32
    }
    pub fn height_capacity(&self) -> u32 {
        self.gpu.height_capacity() as u32
    }
    pub fn available_height_slots(&self) -> u32 {
        if self.is_lost() {
            0
        } else {
            self.gpu.available_height_slots() as u32
        }
    }
    pub fn lighting_epoch(&self) -> f64 {
        self.gpu.lighting_epoch() as f64
    }
    pub fn tile_lighting_epoch(&self, level: u32, x: i32, z: i32) -> f64 {
        Key::new(level, x, z).map_or(0., |key| self.gpu.tile_lighting_epoch(key) as f64)
    }
    pub fn tile_bytes(&self, level: u32) -> f64 {
        self.gpu.tile_bytes(level) as f64
    }
    pub fn height_bytes(&self, level: u32) -> f64 {
        self.gpu.height_bytes(level) as f64
    }
    pub fn resize_bytes(&self, width: u32, height: u32) -> f64 {
        self.gpu.resize_bytes(width, height) as f64
    }
    pub fn height_status(&self) -> u32 {
        self.gpu.height_status()[0] | if self.is_lost() { 8 } else { 0 }
    }
    pub fn height_status_ready(&self) -> bool {
        self.height_status() & 8 == 0
    }
    pub fn missing_height_samples(&self) -> u32 {
        self.gpu.height_status()[1]
    }
    pub fn unknown_height_samples(&self) -> u32 {
        self.gpu.height_status()[2]
    }
    pub fn exhausted_height_samples(&self) -> u32 {
        self.gpu.height_status()[3]
    }
    pub fn upload_peak_bytes(&self) -> f64 {
        self.gpu.upload_peak_bytes() as f64
    }
    pub fn is_lost(&self) -> bool {
        self.lost.load(std::sync::atomic::Ordering::Relaxed)
    }
    pub fn simulate_device_loss(&self) {
        if self.gpu.is_disposed() {
            return;
        }
        self.lost.store(true, std::sync::atomic::Ordering::Relaxed);
        self.gpu.device.destroy();
    }
    pub fn is_disposed(&self) -> bool {
        self.gpu.is_disposed()
    }
    pub fn dispose(&mut self) {
        if !self.active.swap(false, std::sync::atomic::Ordering::AcqRel) {
            return;
        }
        self.gpu.dispose();
        self.gpu.device.destroy();
    }
    #[allow(clippy::too_many_arguments)]
    pub fn render(
        &mut self,
        cx: f64,
        cz: f64,
        physical_scale: f64,
        width: u32,
        height: u32,
        grid: bool,
        shadows: bool,
        elevation: f32,
        azimuth: f32,
        strength: f32,
        vivid: bool,
        relief: f32,
        relief_width: f32,
    ) -> Result<bool, JsValue> {
        self.ensure_active()?;
        if width == 0 || height == 0 {
            return Ok(false);
        }
        if self.config.width != width || self.config.height != height {
            if width > self.gpu.device.limits().max_texture_dimension_2d
                || height > self.gpu.device.limits().max_texture_dimension_2d
            {
                return Err(js_error("LOD canvas exceeds device limits"));
            }
            self.config.width = width;
            self.config.height = height;
            self.surface.configure(&self.gpu.device, &self.config);
        }
        let frame = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(t)
            | wgpu::CurrentSurfaceTexture::Suboptimal(t) => t,
            wgpu::CurrentSurfaceTexture::Timeout | wgpu::CurrentSurfaceTexture::Occluded => {
                return Ok(false);
            }
            wgpu::CurrentSurfaceTexture::Outdated => {
                self.surface.configure(&self.gpu.device, &self.config);
                return Ok(false);
            }
            _ => return Err(js_error("LOD GPU surface unavailable")),
        };
        let view = frame.texture.create_view(&Default::default());
        let rendered = self
            .gpu
            .render(
                &view,
                cx,
                cz,
                physical_scale,
                width,
                height,
                grid,
                shadows,
                elevation,
                azimuth,
                strength,
                vivid,
                relief,
                relief_width,
            )
            .map_err(js_error)?;
        if rendered {
            self.gpu.queue.present(frame);
        }
        Ok(rendered)
    }
}

impl LodRenderer {
    fn ensure_active(&self) -> Result<(), JsValue> {
        if self.is_lost() || self.is_disposed() {
            Err(js_error(
                "LOD GPU unavailable; free and recreate the renderer",
            ))
        } else {
            Ok(())
        }
    }
}
impl Drop for LodRenderer {
    fn drop(&mut self) {
        self.dispose();
    }
}
