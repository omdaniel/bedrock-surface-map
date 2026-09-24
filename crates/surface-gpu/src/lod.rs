//! Bounded, independently resident draw tiles and GPU-built height pages.
//!
//! See `LOD.md` for the browser contract and the memory ledger's scope.
use std::collections::{BTreeMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::{Result, ensure};
use wgpu::util::DeviceExt;

pub const SIDE: usize = 128;
pub const SAMPLES: usize = SIDE * SIDE;
pub const MAX_LEVEL: u32 = 16;
pub const MAX_TILES: usize = 128;
pub const MAX_HEIGHT_PAGES: usize = 128;
pub const HEIGHT_PAGE_BYTES: u64 = 21845 * 8;
const TABLE_ENTRIES: usize = 17 * 256;
const COARSE_BYTES: u64 = 130 * 130 * 8 * 2;
const SHADED_BYTES: u64 = 130 * 130 * 8;
const MAX_QUEUE_BYTES: usize = 2 * 1024 * 1024;
const MAX_GPU_BYTES: u64 = 200_000_000;

pub const TERRAIN: &str = concat!(
    include_str!("appearance.wgsl"),
    "\n",
    include_str!("fine_appearance.wgsl"),
    "\n",
    include_str!("lod_height.wgsl"),
    "\n",
    include_str!("lod_terrain.wgsl"),
    "\n",
    include_str!("relief.wgsl")
);
pub const HEIGHT_BUILD: &str = include_str!("lod_height_build.wgsl");
pub const COARSE_BUILD: &str = include_str!("lod_coarse.wgsl");
pub const COARSE_SHADE: &str = concat!(
    include_str!("appearance.wgsl"),
    "\n",
    include_str!("lod_height.wgsl"),
    "\n",
    include_str!("lod_shade.wgsl"),
    "\n",
    include_str!("relief.wgsl")
);
const RESOLVE: &str = include_str!("lod_resolve.wgsl");

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub struct Key {
    pub level: u32,
    pub x: i32,
    pub z: i32,
}

impl Key {
    pub fn new(level: u32, x: i32, z: i32) -> Result<Self> {
        ensure!(level <= MAX_LEVEL, "LOD level must be 0..16");
        // A one-page guard allows ray traversal and gutter adjacency arithmetic.
        ensure!(
            x.abs_diff(0) < i32::MAX as u32 - 256 && z.abs_diff(0) < i32::MAX as u32 - 256,
            "LOD tile coordinate exceeds GPU page-key range"
        );
        Ok(Self { level, x, z })
    }
    pub fn span(self) -> f64 {
        (128u32 << self.level) as f64
    }
}

#[derive(Clone, Copy, Debug)]
pub struct CutEntry {
    pub key: Key,
    pub opacity: f32,
}

#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
#[repr(C)]
struct DrawUniform {
    origin: [f32; 4],
    key: [i32; 4],
    world: [f32; 4],
}

fn buffer(
    device: &wgpu::Device,
    label: &str,
    data: &[u8],
    usage: wgpu::BufferUsages,
) -> wgpu::Buffer {
    device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some(label),
        contents: data,
        usage,
    })
}
fn entry(binding: u32, b: &wgpu::Buffer) -> wgpu::BindGroupEntry<'_> {
    wgpu::BindGroupEntry {
        binding,
        resource: b.as_entire_binding(),
    }
}
fn tex_entry(binding: u32, v: &wgpu::TextureView) -> wgpu::BindGroupEntry<'_> {
    wgpu::BindGroupEntry {
        binding,
        resource: wgpu::BindingResource::TextureView(v),
    }
}
#[allow(clippy::too_many_arguments)]
fn texture(
    device: &wgpu::Device,
    label: &str,
    width: u32,
    height: u32,
    layers: u32,
    mips: u32,
    format: wgpu::TextureFormat,
    usage: wgpu::TextureUsages,
) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: layers,
        },
        mip_level_count: mips,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage,
        view_formats: &[],
    })
}

struct Tile {
    data: wgpu::Buffer,
    origin: wgpu::Buffer,
    color: Option<wgpu::Texture>,
    lit: Option<wgpu::Texture>,
    group: wgpu::BindGroup,
    shade_group: Option<wgpu::BindGroup>,
    cached_status: Option<wgpu::Buffer>,
    dirty: bool,
    ready: bool,
}
impl Tile {
    fn bytes(&self) -> u64 {
        self.data.size()
            + self.origin.size()
            + self
                .color
                .as_ref()
                .map_or(0, |_| COARSE_BYTES + SHADED_BYTES + 4)
    }
    fn resources(self) -> Vec<Resource> {
        let mut resources = vec![Resource::Buffer(self.data), Resource::Buffer(self.origin)];
        if let Some(t) = self.color {
            resources.push(Resource::Texture(t, COARSE_BYTES));
        }
        if let Some(t) = self.lit {
            resources.push(Resource::Texture(t, SHADED_BYTES));
        }
        if let Some(b) = self.cached_status {
            resources.push(Resource::Buffer(b));
        }
        resources
    }
}
enum Resource {
    Buffer(wgpu::Buffer),
    Texture(wgpu::Texture, u64),
}
impl Resource {
    fn bytes(&self) -> u64 {
        match self {
            Self::Buffer(b) => b.size(),
            Self::Texture(_, bytes) => *bytes,
        }
    }
    fn destroy(self) {
        match self {
            Self::Buffer(b) => b.destroy(),
            Self::Texture(t, _) => t.destroy(),
        }
    }
}
struct Retired {
    serial: u64,
    resources: Vec<Resource>,
    slots: Vec<usize>,
}
#[derive(Default)]
struct Retirement {
    completed: u64,
    entries: Vec<Retired>,
    free_slots: Vec<usize>,
}
impl Retirement {
    fn allocated_bytes(&self) -> u64 {
        self.entries
            .iter()
            .flat_map(|r| &r.resources)
            .map(Resource::bytes)
            .sum()
    }
    fn retiring_bytes(&self) -> u64 {
        self.allocated_bytes()
    }
    fn complete(&mut self, serial: u64) -> bool {
        self.completed = self.completed.max(serial);
        let mut freed = false;
        let mut i = 0;
        while i < self.entries.len() {
            if self.entries[i].serial <= self.completed {
                let r = self.entries.swap_remove(i);
                freed |= !r.resources.is_empty() || !r.slots.is_empty();
                for resource in r.resources {
                    resource.destroy();
                }
                self.free_slots.extend(r.slots);
            } else {
                i += 1;
            }
        }
        freed
    }
}
#[derive(Clone, Copy, Eq, PartialEq)]
enum Kind {
    Tile,
    Height,
}
struct Pending {
    key: Key,
    kind: Kind,
    words: Vec<u32>,
}

struct Target {
    texture: wgpu::Texture,
    view: wgpu::TextureView,
    group: wgpu::BindGroup,
    width: u32,
    height: u32,
}
impl Target {
    fn bytes(&self) -> u64 {
        self.width as u64 * self.height as u64 * 8
    }
}
#[derive(Default)]
struct FeedbackState {
    busy: [bool; 3],
    ready: [bool; 3],
    serials: [u64; 3],
    serial: u64,
    values: [u32; 4],
}

pub struct GpuLod {
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    terrain: wgpu::RenderPipeline,
    resolve: wgpu::RenderPipeline,
    coarse_build: wgpu::ComputePipeline,
    coarse_shade: wgpu::ComputePipeline,
    height_leaves: wgpu::ComputePipeline,
    height_reduce: wgpu::ComputePipeline,
    global: wgpu::BindGroup,
    shade_global: wgpu::BindGroup,
    feedback: wgpu::Buffer,
    readbacks: [wgpu::Buffer; 3],
    feedback_state: Arc<Mutex<FeedbackState>>,
    params: wgpu::Buffer,
    material_buffer: wgpu::Buffer,
    material_count: usize,
    atlas: wgpu::Texture,
    atlas_view: wgpu::TextureView,
    atlas_bytes: u64,
    atlas_sampler: wgpu::Sampler,
    coarse_sampler: wgpu::Sampler,
    dummy: wgpu::Texture,
    dummy_view: wgpu::TextureView,
    empty_status: wgpu::Buffer,
    gutter_scratch: wgpu::Buffer,
    page_table: wgpu::Buffer,
    nodes: wgpu::Buffer,
    capacity: usize,
    free_slots: Vec<usize>,
    tiles: BTreeMap<Key, Tile>,
    heights: BTreeMap<Key, usize>,
    pending: VecDeque<Pending>,
    cut: Vec<CutEntry>,
    target: Option<Target>,
    retirement: Mutex<Retirement>,
    completed: Arc<AtomicU64>,
    submitted: u64,
    upload_peak: usize,
    world: Option<([i32; 4], i32)>,
    lighting: Option<[f32; 8]>,
}

fn render_pipeline(
    device: &wgpu::Device,
    label: &str,
    code: &str,
    format: wgpu::TextureFormat,
    blend: Option<wgpu::BlendState>,
) -> wgpu::RenderPipeline {
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some(label),
        source: wgpu::ShaderSource::Wgsl(code.into()),
    });
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some(label),
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
                blend,
                write_mask: wgpu::ColorWrites::ALL,
            })],
            compilation_options: Default::default(),
        }),
        primitive: Default::default(),
        depth_stencil: None,
        multisample: Default::default(),
        multiview_mask: None,
        cache: None,
    })
}

fn validate_materials(values: &[f32]) -> Result<()> {
    ensure!(
        !values.is_empty()
            && values.len().is_multiple_of(12)
            && values.len() <= 65536 * 12
            && values.iter().all(|v| v.is_finite()),
        "invalid LOD material catalog"
    );
    Ok(())
}

impl GpuLod {
    /// Atlas base level is uploaded by the caller; mip generation uses the same
    /// GPU compute filter as the legacy renderer and retains atlas padding.
    pub fn new(
        device: wgpu::Device,
        queue: wgpu::Queue,
        format: wgpu::TextureFormat,
        materials: &[f32],
        atlas: wgpu::Texture,
    ) -> Result<Self> {
        validate_materials(materials)?;
        let additive = wgpu::BlendComponent {
            src_factor: wgpu::BlendFactor::One,
            dst_factor: wgpu::BlendFactor::One,
            operation: wgpu::BlendOperation::Add,
        };
        let terrain = render_pipeline(
            &device,
            "paged LOD terrain",
            TERRAIN,
            wgpu::TextureFormat::Rgba16Float,
            Some(wgpu::BlendState {
                color: additive,
                alpha: additive,
            }),
        );
        let resolve = render_pipeline(&device, "LOD cut resolve", RESOLVE, format, None);
        let coarse_build =
            crate::compute_pipeline(&device, "unlit LOD summaries", COARSE_BUILD, "prepare");
        let coarse_shade =
            crate::compute_pipeline(&device, "cached LOD lighting", COARSE_SHADE, "shade_coarse");
        let height_leaves =
            crate::compute_pipeline(&device, "LOD height leaves", HEIGHT_BUILD, "leaves");
        let height_reduce =
            crate::compute_pipeline(&device, "LOD height max hierarchy", HEIGHT_BUILD, "reduce");
        let params = buffer(
            &device,
            "LOD camera",
            &[0u8; 80],
            wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        );
        let material_buffer = buffer(
            &device,
            "LOD materials",
            bytemuck::cast_slice(materials),
            wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        );
        let atlas_view = atlas.create_view(&Default::default());
        let atlas_sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            mag_filter: wgpu::FilterMode::Nearest,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::MipmapFilterMode::Linear,
            ..Default::default()
        });
        let coarse_sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let dummy = texture(
            &device,
            "fine tile unused coarse binding",
            1,
            1,
            1,
            1,
            wgpu::TextureFormat::Rgba16Float,
            wgpu::TextureUsages::TEXTURE_BINDING,
        );
        let dummy_view = dummy.create_view(&Default::default());
        let empty_status = buffer(
            &device,
            "unused fine cache status",
            &[0u8; 4],
            wgpu::BufferUsages::STORAGE,
        );
        let gutter_scratch = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("bounded LOD gutter copy scratch"),
            size: 65536,
            usage: wgpu::BufferUsages::COPY_SRC | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let page_table = buffer(
            &device,
            "LOD bounded page tables",
            &vec![0u8; TABLE_ENTRIES * 16],
            wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        );
        let capacity = MAX_HEIGHT_PAGES;
        let nodes = Self::arena(&device, capacity);
        let feedback = buffer(
            &device,
            "LOD height coverage feedback",
            &[0u8; 16],
            wgpu::BufferUsages::STORAGE
                | wgpu::BufferUsages::COPY_SRC
                | wgpu::BufferUsages::COPY_DST,
        );
        let readbacks = std::array::from_fn(|_| {
            device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("bounded LOD feedback readback"),
                size: 16,
                usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                mapped_at_creation: false,
            })
        });
        let global = Self::bind_global(
            &device,
            &terrain,
            &params,
            &material_buffer,
            &atlas_view,
            &atlas_sampler,
            &coarse_sampler,
            &page_table,
            &nodes,
            &feedback,
        );
        let shade_global = Self::bind_shade(
            &device,
            &coarse_shade,
            &params,
            &page_table,
            &nodes,
            &feedback,
        );
        let atlas_bytes = (0..atlas.mip_level_count())
            .map(|m| (atlas.width() >> m).max(1) as u64 * (atlas.height() >> m).max(1) as u64 * 4)
            .sum();
        let mut this = Self {
            device,
            queue,
            terrain,
            resolve,
            coarse_build,
            coarse_shade,
            height_leaves,
            height_reduce,
            global,
            shade_global,
            feedback,
            readbacks,
            feedback_state: Arc::default(),
            params,
            material_buffer,
            material_count: materials.len() / 12,
            atlas,
            atlas_view,
            atlas_bytes,
            atlas_sampler,
            coarse_sampler,
            dummy,
            dummy_view,
            empty_status,
            gutter_scratch,
            page_table,
            nodes,
            capacity,
            free_slots: (0..capacity).rev().collect(),
            tiles: BTreeMap::new(),
            heights: BTreeMap::new(),
            pending: VecDeque::new(),
            cut: Vec::new(),
            target: None,
            retirement: Mutex::default(),
            completed: Arc::default(),
            submitted: 0,
            upload_peak: 0,
            world: None,
            lighting: None,
        };
        this.generate_atlas_mips();
        Ok(this)
    }
    fn arena(device: &wgpu::Device, capacity: usize) -> wgpu::Buffer {
        device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("LOD height arena"),
            size: capacity as u64 * HEIGHT_PAGE_BYTES,
            usage: wgpu::BufferUsages::STORAGE
                | wgpu::BufferUsages::COPY_SRC
                | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        })
    }
    #[allow(clippy::too_many_arguments)]
    fn bind_global(
        device: &wgpu::Device,
        pipeline: &wgpu::RenderPipeline,
        params: &wgpu::Buffer,
        materials: &wgpu::Buffer,
        atlas: &wgpu::TextureView,
        atlas_sampler: &wgpu::Sampler,
        coarse_sampler: &wgpu::Sampler,
        table: &wgpu::Buffer,
        nodes: &wgpu::Buffer,
        feedback: &wgpu::Buffer,
    ) -> wgpu::BindGroup {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("LOD global pages and appearance"),
            layout: &pipeline.get_bind_group_layout(0),
            entries: &[
                entry(0, params),
                entry(1, materials),
                tex_entry(2, atlas),
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::Sampler(atlas_sampler),
                },
                entry(4, table),
                entry(5, nodes),
                wgpu::BindGroupEntry {
                    binding: 6,
                    resource: wgpu::BindingResource::Sampler(coarse_sampler),
                },
                entry(7, feedback),
            ],
        })
    }
    fn bind_shade(
        device: &wgpu::Device,
        pipeline: &wgpu::ComputePipeline,
        params: &wgpu::Buffer,
        table: &wgpu::Buffer,
        nodes: &wgpu::Buffer,
        feedback: &wgpu::Buffer,
    ) -> wgpu::BindGroup {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("LOD cached lighting globals"),
            layout: &pipeline.get_bind_group_layout(0),
            entries: &[
                entry(0, params),
                entry(4, table),
                entry(5, nodes),
                entry(7, feedback),
            ],
        })
    }
    fn rebind(&mut self) {
        self.global = Self::bind_global(
            &self.device,
            &self.terrain,
            &self.params,
            &self.material_buffer,
            &self.atlas_view,
            &self.atlas_sampler,
            &self.coarse_sampler,
            &self.page_table,
            &self.nodes,
            &self.feedback,
        );
        self.shade_global = Self::bind_shade(
            &self.device,
            &self.coarse_shade,
            &self.params,
            &self.page_table,
            &self.nodes,
            &self.feedback,
        );
    }
    fn generate_atlas_mips(&mut self) {
        let pipeline = crate::compute_pipeline(
            &self.device,
            "LOD shared atlas mip filter",
            crate::MIP_SHADER,
            "mip",
        );
        let mut encoder = self.device.create_command_encoder(&Default::default());
        for mip in 1..self.atlas.mip_level_count() {
            let source = self.atlas.create_view(&wgpu::TextureViewDescriptor {
                base_mip_level: mip - 1,
                mip_level_count: Some(1),
                ..Default::default()
            });
            let dest = self.atlas.create_view(&wgpu::TextureViewDescriptor {
                base_mip_level: mip,
                mip_level_count: Some(1),
                ..Default::default()
            });
            let group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: None,
                layout: &pipeline.get_bind_group_layout(0),
                entries: &[tex_entry(0, &source), tex_entry(1, &dest)],
            });
            let mut pass = encoder.begin_compute_pass(&Default::default());
            pass.set_pipeline(&pipeline);
            pass.set_bind_group(0, &group, &[]);
            pass.dispatch_workgroups(
                (self.atlas.width() >> mip).max(1).div_ceil(8),
                (self.atlas.height() >> mip).max(1).div_ceil(8),
                1,
            );
        }
        self.submit(encoder);
    }
    fn retire(&mut self, resources: Vec<Resource>, slots: Vec<usize>) {
        self.retirement.lock().unwrap().entries.push(Retired {
            serial: self.submitted + 1,
            resources,
            slots,
        });
    }
    fn submit(&mut self, encoder: wgpu::CommandEncoder) {
        self.submitted += 1;
        let serial = self.submitted;
        self.queue.submit([encoder.finish()]);
        let completed = self.completed.clone();
        self.queue.on_submitted_work_done(move || {
            completed.fetch_max(serial, Ordering::Release);
            #[cfg(target_arch = "wasm32")]
            if let (Some(window), Ok(event)) = (
                web_sys::window(),
                web_sys::Event::new("surface-lod-retired"),
            ) {
                let _ = window.dispatch_event(&event);
            }
        });
    }
    fn reap(&self) {
        self.retirement
            .lock()
            .unwrap()
            .complete(self.completed.load(Ordering::Acquire));
    }
    pub fn gpu_bytes(&self) -> u64 {
        self.reap();
        self.params.size()
            + self.material_buffer.size()
            + self.atlas_bytes
            + 8
            + 68
            + self.gutter_scratch.size()
            + self.page_table.size()
            + self.nodes.size()
            + self.tiles.values().map(Tile::bytes).sum::<u64>()
            + self.target.as_ref().map_or(0, Target::bytes)
            + self.retirement.lock().unwrap().allocated_bytes()
    }
    pub fn cpu_bytes(&self) -> usize {
        // Rust payload allocations and conservatively charged map metadata. The
        // external ImageBitmap and caller's typed arrays remain caller-owned.
        self.pending
            .iter()
            .map(|p| p.words.capacity() * 4)
            .sum::<usize>()
            + self.pending.capacity() * std::mem::size_of::<Pending>()
            + self.cut.capacity() * std::mem::size_of::<CutEntry>()
            + (self.tiles.len() + self.heights.len()) * 256
            + self.free_slots.capacity() * std::mem::size_of::<usize>()
            + std::mem::size_of::<Self>()
    }
    pub fn upload_peak_bytes(&self) -> usize {
        self.upload_peak
    }
    pub fn retiring_bytes(&self) -> u64 {
        self.reap();
        self.retirement.lock().unwrap().retiring_bytes()
    }
    pub fn retiring_height_slots(&self) -> usize {
        self.reap();
        self.retirement
            .lock()
            .unwrap()
            .entries
            .iter()
            .map(|r| r.slots.len())
            .sum()
    }
    pub fn pending_submissions(&self) -> u64 {
        self.reap();
        self.submitted - self.completed.load(Ordering::Acquire)
    }
    pub fn pending_tiles(&self) -> usize {
        self.pending.len()
    }
    pub fn pending_preparations(&self) -> usize {
        self.pending.len() + self.tiles.values().filter(|t| t.dirty).count()
    }
    pub fn pending_uploads(&self) -> usize {
        self.pending.len()
    }
    pub fn height_status(&self) -> [u32; 4] {
        self.reap_feedback();
        self.feedback_state.lock().unwrap().values
    }
    pub fn height_capacity(&self) -> usize {
        self.capacity
    }
    pub fn set_world(&mut self, bounds: [i32; 4], height_max: i32) -> Result<()> {
        ensure!(
            bounds[0] < bounds[2]
                && bounds[1] < bounds[3]
                && (i16::MIN as i32..=i16::MAX as i32).contains(&height_max),
            "invalid LOD world bounds or quantized height maximum"
        );
        self.world = Some((bounds, height_max));
        self.dirty_coarse();
        Ok(())
    }
    pub fn has_tile(&self, key: Key) -> bool {
        self.tiles.get(&key).is_some_and(|t| t.ready)
    }
    pub fn has_height(&self, key: Key) -> bool {
        self.heights.contains_key(&key)
    }
    pub fn tile_bytes(&self, level: u32) -> u64 {
        if level == 0 {
            SAMPLES as u64 * 32 + 48
        } else {
            SAMPLES as u64 * 24 + 48 + COARSE_BYTES + SHADED_BYTES + 4
        }
    }
    /// Incremental GPU reservation for temporary upload/build buffers. Page slots
    /// belong to the separately charged fixed arena, including during retirement.
    pub fn height_bytes(&self, level: u32) -> u64 {
        SAMPLES as u64 * if level == 0 { 4 } else { 8 } + 8 * 16 + (TABLE_ENTRIES * 16) as u64
    }
    fn validate_words(&self, key: Key, kind: Kind, words: &[u32]) -> Result<()> {
        let stride = match (kind, key.level) {
            (Kind::Tile, 0) => 8,
            (Kind::Tile, _) => 6,
            (Kind::Height, 0) => 1,
            _ => 2,
        };
        ensure!(
            words.len() == SAMPLES * stride,
            "LOD page word count mismatch"
        );
        if kind == Kind::Tile && key.level == 0 {
            for c in words.chunks_exact(8) {
                ensure!(
                    c[1] < self.material_count as u32
                        && c[3] < self.material_count as u32
                        && c[5] < self.material_count as u32,
                    "LOD material ID outside catalog"
                );
                ensure!(
                    c[7] <= 3
                        && (c[0] as i32) >= i16::MIN as i32
                        && (c[0] as i32) <= i16::MAX as i32,
                    "invalid detail height or coverage"
                );
            }
        }
        Ok(())
    }
    fn enqueue(&mut self, key: Key, kind: Kind, words: Vec<u32>) -> Result<()> {
        self.validate_words(key, kind, &words)?;
        let replaced = self
            .pending
            .iter()
            .find(|p| p.key == key && p.kind == kind)
            .map_or(0, |p| p.words.len() * 4);
        let queued: usize = self.pending.iter().map(|p| p.words.len() * 4).sum();
        ensure!(
            queued - replaced + words.len() * 4 <= MAX_QUEUE_BYTES,
            "LOD upload queue full"
        );
        if kind == Kind::Tile {
            let additions = self
                .pending
                .iter()
                .filter(|p| p.kind == kind && !self.tiles.contains_key(&p.key))
                .count();
            ensure!(
                self.tiles.contains_key(&key)
                    || replaced != 0
                    || self.tiles.len() + additions < MAX_TILES,
                "LOD tile slots full"
            );
        } else {
            let additions = self
                .pending
                .iter()
                .filter(|p| p.kind == kind && !self.heights.contains_key(&p.key))
                .count();
            // One slot remains available to prepare a replacement atomically.
            ensure!(
                self.heights.contains_key(&key)
                    || replaced != 0
                    || self.heights.len() + additions < MAX_HEIGHT_PAGES - 1,
                "LOD height slots full"
            );
        }
        self.upload_peak = self.upload_peak.max(self.cpu_bytes() + words.len() * 4);
        self.pending.retain(|p| p.key != key || p.kind != kind);
        self.pending.push_back(Pending { key, kind, words });
        Ok(())
    }
    pub fn add_tile(&mut self, key: Key, words: Vec<u32>) -> Result<()> {
        self.enqueue(key, Kind::Tile, words)
    }
    pub fn add_height(&mut self, key: Key, words: Vec<u32>) -> Result<()> {
        self.enqueue(key, Kind::Height, words)
    }
    pub fn set_cut(&mut self, cut: Vec<CutEntry>) -> Result<()> {
        ensure!(cut.len() <= MAX_TILES, "LOD draw cut exceeds 128 entries");
        let mut keys = std::collections::BTreeSet::new();
        for e in &cut {
            ensure!(
                e.opacity.is_finite() && (0.0..=1.0).contains(&e.opacity),
                "invalid cut opacity"
            );
            ensure!(keys.insert(e.key), "duplicate tile in draw cut");
            ensure!(self.has_tile(e.key), "draw cut includes an unprepared tile");
        }
        self.cut = cut;
        Ok(())
    }
    pub fn set_materials(&mut self, values: &[f32]) -> Result<()> {
        validate_materials(values)?;
        ensure!(
            values.len() / 12 >= self.material_count,
            "material update cannot remove IDs from resident tiles"
        );
        ensure!(
            self.gpu_bytes() + values.len() as u64 * 4 <= MAX_GPU_BYTES,
            "LOD GPU budget exhausted"
        );
        let new = buffer(
            &self.device,
            "updated LOD materials",
            bytemuck::cast_slice(values),
            wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        );
        let old = std::mem::replace(&mut self.material_buffer, new);
        self.material_count = values.len() / 12;
        self.rebind();
        self.retire(vec![Resource::Buffer(old)], vec![]);
        // No tile regeneration: fine appearance reads the catalog dynamically;
        // coarse summaries are versioned/replaced by the caller with the catalog.
        self.submit(self.device.create_command_encoder(&Default::default()));
        Ok(())
    }
    pub fn update_materials(&mut self, start: u32, values: &[f32]) -> Result<()> {
        validate_materials(values)?;
        ensure!(
            start as usize <= self.material_count
                && values.len() / 12 <= self.material_count - start as usize,
            "LOD material update exceeds catalog range"
        );
        ensure!(
            self.gpu_bytes() + values.len() as u64 * 4 <= MAX_GPU_BYTES,
            "LOD material upload exceeds GPU budget"
        );
        let staging = buffer(
            &self.device,
            "LOD material range upload",
            bytemuck::cast_slice(values),
            wgpu::BufferUsages::COPY_SRC,
        );
        let mut encoder = self.device.create_command_encoder(&Default::default());
        encoder.copy_buffer_to_buffer(
            &staging,
            0,
            &self.material_buffer,
            start as u64 * 48,
            staging.size(),
        );
        self.upload_peak = self.upload_peak.max(self.cpu_bytes() + values.len() * 4);
        self.retire(vec![Resource::Buffer(staging)], vec![]);
        self.submit(encoder);
        Ok(())
    }
    pub fn remove_tile(&mut self, key: Key) {
        self.pending
            .retain(|p| p.kind != Kind::Tile || p.key != key);
        if let Some(tile) = self.tiles.remove(&key) {
            self.cut.retain(|e| e.key != key);
            self.retire(tile.resources(), vec![]);
            let mut encoder = self.device.create_command_encoder(&Default::default());
            self.reset_neighbor_gutters(key, &mut encoder);
            self.submit(encoder);
        }
    }
    pub fn remove_height(&mut self, key: Key) {
        self.pending
            .retain(|p| p.kind != Kind::Height || p.key != key);
        if let Some(slot) = self.heights.remove(&key) {
            self.retire(vec![], vec![slot]);
            self.dirty_height_dependents(key);
            let mut encoder = self.device.create_command_encoder(&Default::default());
            self.upload_table(&mut encoder);
            self.submit(encoder);
        }
    }
    fn upload_table(&mut self, encoder: &mut wgpu::CommandEncoder) {
        let mut entries = vec![[0i32; 4]; TABLE_ENTRIES];
        for (key, slot) in &self.heights {
            let mut h = page_hash(key.x, key.z);
            while entries[key.level as usize * 256 + h][2] != 0 {
                h = (h + 1) & 255;
            }
            entries[key.level as usize * 256 + h] = [key.x, key.z, *slot as i32 + 1, 0];
        }
        let staging = buffer(
            &self.device,
            "LOD bounded page table upload",
            bytemuck::cast_slice(&entries),
            wgpu::BufferUsages::COPY_SRC,
        );
        encoder.copy_buffer_to_buffer(&staging, 0, &self.page_table, 0, staging.size());
        self.upload_peak = self.upload_peak.max(self.cpu_bytes() + TABLE_ENTRIES * 16);
        self.retire(vec![Resource::Buffer(staging)], vec![]);
    }
    fn prepare_height(&mut self, key: Key, words: &[u32], encoder: &mut wgpu::CommandEncoder) {
        let slot = self.free_slots.pop().unwrap();
        let input = buffer(
            &self.device,
            "one LOD height upload",
            bytemuck::cast_slice(words),
            wgpu::BufferUsages::STORAGE,
        );
        let mut temporary = Vec::with_capacity(9);
        for mip in 0..8u32 {
            let pipeline = if mip == 0 {
                &self.height_leaves
            } else {
                &self.height_reduce
            };
            let uniform = buffer(
                &self.device,
                "LOD page build parameters",
                bytemuck::cast_slice(&[slot as u32, key.level, mip, 0]),
                wgpu::BufferUsages::UNIFORM,
            );
            let group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("one height page hierarchy pass"),
                layout: &pipeline.get_bind_group_layout(0),
                entries: if mip == 0 {
                    vec![entry(0, &input), entry(1, &self.nodes), entry(2, &uniform)]
                } else {
                    vec![entry(1, &self.nodes), entry(2, &uniform)]
                }
                .as_slice(),
            });
            {
                let mut pass = encoder.begin_compute_pass(&Default::default());
                pass.set_pipeline(pipeline);
                pass.set_bind_group(0, &group, &[]);
                let groups = (128u32 >> mip).div_ceil(8);
                pass.dispatch_workgroups(groups, groups, 1);
            }
            temporary.push(Resource::Buffer(uniform));
        }
        temporary.push(Resource::Buffer(input));
        let old_slot = self.heights.insert(key, slot);
        self.dirty_height_dependents(key);
        self.retire(temporary, old_slot.into_iter().collect());
        self.upload_table(encoder);
    }
    fn prepare_tile(&mut self, key: Key, words: &[u32], encoder: &mut wgpu::CommandEncoder) {
        let data = buffer(
            &self.device,
            "one LOD tile payload",
            bytemuck::cast_slice(words),
            wgpu::BufferUsages::STORAGE,
        );
        let origin = buffer(
            &self.device,
            "LOD camera-relative tile",
            &[0u8; 48],
            wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        );
        let color = if key.level == 0 {
            None
        } else {
            let t = texture(
                &self.device,
                "unlit coarse tile with sibling gutters",
                130,
                130,
                2,
                1,
                wgpu::TextureFormat::Rgba16Float,
                wgpu::TextureUsages::TEXTURE_BINDING
                    | wgpu::TextureUsages::STORAGE_BINDING
                    | wgpu::TextureUsages::COPY_SRC
                    | wgpu::TextureUsages::COPY_DST,
            );
            let view = t.create_view(&Default::default());
            let group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: None,
                layout: &self.coarse_build.get_bind_group_layout(0),
                entries: &[entry(0, &data), tex_entry(1, &view)],
            });
            {
                let mut pass = encoder.begin_compute_pass(&Default::default());
                pass.set_pipeline(&self.coarse_build);
                pass.set_bind_group(0, &group, &[]);
                pass.dispatch_workgroups(17, 17, 1);
            }
            Some(t)
        };
        let lit = color.as_ref().map(|_| {
            texture(
                &self.device,
                "cached coarse lighting",
                130,
                130,
                1,
                1,
                wgpu::TextureFormat::Rgba16Float,
                wgpu::TextureUsages::TEXTURE_BINDING
                    | wgpu::TextureUsages::STORAGE_BINDING
                    | wgpu::TextureUsages::COPY_SRC
                    | wgpu::TextureUsages::COPY_DST,
            )
        });
        let view = lit.as_ref().map(|t| t.create_view(&Default::default()));
        let cached_status = color.as_ref().map(|_| {
            buffer(
                &self.device,
                "cached LOD approximation flags",
                &[0u8; 4],
                wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            )
        });
        let shade_group = color.as_ref().map(|t| {
            let unlit_view = t.create_view(&Default::default());
            self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("LOD tile relight"),
                layout: &self.coarse_shade.get_bind_group_layout(1),
                entries: &[
                    entry(0, &data),
                    entry(1, &origin),
                    tex_entry(2, &unlit_view),
                    tex_entry(3, view.as_ref().unwrap()),
                    entry(4, cached_status.as_ref().unwrap()),
                ],
            })
        });
        let group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("LOD draw tile"),
            layout: &self.terrain.get_bind_group_layout(1),
            entries: &[
                entry(0, &data),
                entry(1, &origin),
                tex_entry(2, view.as_ref().unwrap_or(&self.dummy_view)),
                entry(3, cached_status.as_ref().unwrap_or(&self.empty_status)),
            ],
        });
        let tile = Tile {
            data,
            origin,
            color,
            lit,
            group,
            shade_group,
            cached_status,
            dirty: key.level != 0,
            ready: key.level == 0,
        };
        if let Some(old) = self.tiles.insert(key, tile) {
            self.retire(old.resources(), vec![]);
        }
        self.stitch_gutters(key, encoder);
    }
    fn stitch_gutters(&self, key: Key, encoder: &mut wgpu::CommandEncoder) {
        let Some(current) = self.tiles.get(&key).and_then(|t| t.color.as_ref()) else {
            return;
        };
        for dz in -1..=1i32 {
            for dx in -1..=1i32 {
                if dx == 0 && dz == 0 {
                    continue;
                }
                let neighbor_key = Key {
                    level: key.level,
                    x: key.x + dx,
                    z: key.z + dz,
                };
                let Some(neighbor) = self.tiles.get(&neighbor_key).and_then(|t| t.color.as_ref())
                else {
                    continue;
                };
                let width = if dx == 0 { 128 } else { 1 };
                let height = if dz == 0 { 128 } else { 1 };
                let inside = |d: i32| {
                    if d < 0 {
                        1
                    } else if d > 0 {
                        128
                    } else {
                        1
                    }
                };
                let outside = |d: i32| {
                    if d < 0 {
                        0
                    } else if d > 0 {
                        129
                    } else {
                        1
                    }
                };
                copy_edge(
                    encoder,
                    neighbor,
                    [inside(-dx), inside(-dz)],
                    current,
                    [outside(dx), outside(dz)],
                    [width, height],
                );
                copy_edge(
                    encoder,
                    current,
                    [inside(dx), inside(dz)],
                    neighbor,
                    [outside(-dx), outside(-dz)],
                    [width, height],
                );
            }
        }
    }
    fn prepare_one(&mut self, encoder: &mut wgpu::CommandEncoder) -> Result<Option<(Kind, Key)>> {
        self.free_slots.extend(std::mem::take(
            &mut self.retirement.lock().unwrap().free_slots,
        ));
        let Some(next) = self.pending.front() else {
            return Ok(None);
        };
        if next.kind == Kind::Height
            && self.free_slots.is_empty()
            && self.capacity == MAX_HEIGHT_PAGES
        {
            return Ok(None);
        }
        let reservation = if next.kind == Kind::Height {
            self.height_bytes(next.key.level)
        } else {
            self.tile_bytes(next.key.level)
        };
        ensure!(
            self.gpu_bytes() + reservation <= MAX_GPU_BYTES,
            "LOD GPU preparation exceeds 200 MB budget"
        );
        let next = self.pending.pop_front().unwrap();
        match next.kind {
            Kind::Tile => self.prepare_tile(next.key, &next.words, encoder),
            Kind::Height => self.prepare_height(next.key, &next.words, encoder),
        }
        Ok(Some((next.kind, next.key)))
    }
    fn dirty_coarse(&mut self) {
        for tile in self.tiles.values_mut() {
            tile.dirty = tile.color.is_some();
        }
    }
    fn dirty_height_dependents(&mut self, height: Key) {
        for (key, tile) in &mut self.tiles {
            if key.level == height.level && tile.color.is_some() {
                tile.dirty = true;
            }
        }
    }
    fn reset_neighbor_gutters(&self, removed: Key, encoder: &mut wgpu::CommandEncoder) {
        for dz in -1..=1 {
            for dx in -1..=1 {
                if dx == 0 && dz == 0 {
                    continue;
                }
                let key = Key {
                    level: removed.level,
                    x: removed.x + dx,
                    z: removed.z + dz,
                };
                let Some(tile) = self.tiles.get(&key) else {
                    continue;
                };
                let inside = |d: i32| {
                    if d > 0 {
                        1
                    } else if d < 0 {
                        128
                    } else {
                        1
                    }
                };
                let outside = |d: i32| {
                    if d > 0 {
                        0
                    } else if d < 0 {
                        129
                    } else {
                        1
                    }
                };
                let size = [if dx == 0 { 128 } else { 1 }, if dz == 0 { 128 } else { 1 }];
                for texture in [&tile.color, &tile.lit].into_iter().flatten() {
                    self.copy_own_edge(
                        encoder,
                        texture,
                        [inside(dx), inside(dz)],
                        [outside(dx), outside(dz)],
                        size,
                    );
                }
            }
        }
    }
    fn copy_own_edge(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        texture: &wgpu::Texture,
        src: [u32; 2],
        dst: [u32; 2],
        size: [u32; 2],
    ) {
        let layout = wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some((size[0] * 8).div_ceil(256) * 256),
            rows_per_image: Some(size[1]),
        };
        let extent = wgpu::Extent3d {
            width: size[0],
            height: size[1],
            depth_or_array_layers: texture.depth_or_array_layers(),
        };
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture,
                mip_level: 0,
                origin: wgpu::Origin3d {
                    x: src[0],
                    y: src[1],
                    z: 0,
                },
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &self.gutter_scratch,
                layout,
            },
            extent,
        );
        encoder.copy_buffer_to_texture(
            wgpu::TexelCopyBufferInfo {
                buffer: &self.gutter_scratch,
                layout,
            },
            wgpu::TexelCopyTextureInfo {
                texture,
                mip_level: 0,
                origin: wgpu::Origin3d {
                    x: dst[0],
                    y: dst[1],
                    z: 0,
                },
                aspect: wgpu::TextureAspect::All,
            },
            extent,
        );
    }
    fn shade_one(&mut self, key: Key, encoder: &mut wgpu::CommandEncoder) {
        let tile = self.tiles.get_mut(&key).unwrap();
        encoder.clear_buffer(tile.cached_status.as_ref().unwrap(), 0, None);
        {
            let mut pass = encoder.begin_compute_pass(&Default::default());
            pass.set_pipeline(&self.coarse_shade);
            pass.set_bind_group(0, &self.shade_global, &[]);
            pass.set_bind_group(1, tile.shade_group.as_ref().unwrap(), &[]);
            pass.dispatch_workgroups(17, 17, 1);
        }
        tile.dirty = false;
        tile.ready = true;
        self.stitch_lit_gutters(key, encoder);
    }
    fn stitch_lit_gutters(&self, key: Key, encoder: &mut wgpu::CommandEncoder) {
        let Some(current) = self.tiles.get(&key).and_then(|t| t.lit.as_ref()) else {
            return;
        };
        for dz in -1..=1i32 {
            for dx in -1..=1i32 {
                if dx == 0 && dz == 0 {
                    continue;
                }
                let neighbor_key = Key {
                    level: key.level,
                    x: key.x + dx,
                    z: key.z + dz,
                };
                let Some(tile) = self
                    .tiles
                    .get(&neighbor_key)
                    .filter(|t| !t.dirty && t.ready)
                else {
                    continue;
                };
                let Some(neighbor) = &tile.lit else {
                    continue;
                };
                let width = if dx == 0 { 128 } else { 1 };
                let height = if dz == 0 { 128 } else { 1 };
                let inside = |d: i32| {
                    if d < 0 {
                        1
                    } else if d > 0 {
                        128
                    } else {
                        1
                    }
                };
                let outside = |d: i32| {
                    if d < 0 {
                        0
                    } else if d > 0 {
                        129
                    } else {
                        1
                    }
                };
                copy_edge(
                    encoder,
                    neighbor,
                    [inside(-dx), inside(-dz)],
                    current,
                    [outside(dx), outside(dz)],
                    [width, height],
                );
                copy_edge(
                    encoder,
                    current,
                    [inside(dx), inside(dz)],
                    neighbor,
                    [outside(-dx), outside(-dz)],
                    [width, height],
                );
            }
        }
    }
    fn resize(&mut self, width: u32, height: u32) -> Result<()> {
        if self
            .target
            .as_ref()
            .is_some_and(|t| t.width == width && t.height == height)
        {
            return Ok(());
        }
        ensure!(
            width > 0
                && height > 0
                && width <= self.device.limits().max_texture_dimension_2d
                && height <= self.device.limits().max_texture_dimension_2d,
            "invalid LOD target dimensions"
        );
        ensure!(
            self.gpu_bytes() + width as u64 * height as u64 * 8 <= MAX_GPU_BYTES,
            "LOD target exceeds GPU budget"
        );
        let texture = texture(
            &self.device,
            "LOD additive cut accumulation",
            width,
            height,
            1,
            1,
            wgpu::TextureFormat::Rgba16Float,
            wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
        );
        let view = texture.create_view(&Default::default());
        let group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("LOD cut resolve"),
            layout: &self.resolve.get_bind_group_layout(0),
            entries: &[tex_entry(0, &view)],
        });
        if let Some(old) = self.target.replace(Target {
            texture,
            view,
            group,
            width,
            height,
        }) {
            let bytes = old.bytes();
            self.retire(vec![Resource::Texture(old.texture, bytes)], vec![]);
        }
        Ok(())
    }
    pub fn resize_bytes(&self, width: u32, height: u32) -> u64 {
        if self
            .target
            .as_ref()
            .is_some_and(|t| t.width == width && t.height == height)
        {
            0
        } else {
            width as u64 * height as u64 * 8
        }
    }
    fn read_feedback(&self, index: usize, serial: u64) {
        let state = self.feedback_state.clone();
        self.readbacks[index]
            .slice(..)
            .map_async(wgpu::MapMode::Read, move |result| {
                let mut state = state.lock().unwrap();
                state.ready[index] = result.is_ok();
                state.busy[index] = result.is_ok();
                state.serials[index] = serial;
            });
    }
    fn reap_feedback(&self) {
        let mut state = self.feedback_state.lock().unwrap();
        for index in 0..3 {
            if !state.ready[index] {
                continue;
            }
            if let Ok(mapped) = self.readbacks[index].slice(..).get_mapped_range() {
                if state.serials[index] >= state.serial {
                    state.values.copy_from_slice(bytemuck::cast_slice(&mapped));
                    state.serial = state.serials[index];
                }
                drop(mapped);
            }
            self.readbacks[index].unmap();
            state.ready[index] = false;
            state.busy[index] = false;
        }
    }
    #[allow(clippy::too_many_arguments)]
    pub fn render(
        &mut self,
        output: &wgpu::TextureView,
        cx: f64,
        cz: f64,
        scale: f64,
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
    ) -> Result<bool> {
        ensure!(
            cx.is_finite()
                && cz.is_finite()
                && scale.is_finite()
                && scale > 0.0
                && scale <= 65536.0,
            "invalid LOD camera"
        );
        ensure!(
            (15.0..=75.0).contains(&elevation)
                && (0.0..=360.0).contains(&azimuth)
                && (0.0..=0.8).contains(&strength)
                && (0.0..=1.0).contains(&relief)
                && (0.05..=0.5).contains(&relief_width),
            "invalid LOD lighting"
        );
        if width == 0 || height == 0 {
            return Ok(false);
        }
        let (bounds, height_max) = self
            .world
            .ok_or_else(|| anyhow::anyhow!("set_world is required before LOD rendering"))?;
        self.reap_feedback();
        if self.pending_submissions() >= 3 {
            return Ok(false);
        }
        let upload_bytes = 80 + (self.tiles.len() as u64 + 1) * 48;
        let prepare_bytes = self.pending.front().map_or(0, |next| {
            if next.kind == Kind::Height {
                self.height_bytes(next.key.level)
            } else {
                self.tile_bytes(next.key.level)
            }
        });
        ensure!(
            self.gpu_bytes() + self.resize_bytes(width, height) + prepare_bytes + upload_bytes
                <= MAX_GPU_BYTES,
            "LOD frame exceeds 200 MB GPU budget"
        );
        self.resize(width, height)?;
        let mut encoder = self.device.create_command_encoder(&Default::default());
        let prepared = self.prepare_one(&mut encoder)?;
        encoder.clear_buffer(&self.feedback, 0, None);
        let direction = surface_core::sun_direction(azimuth);
        let lighting = [
            shadows as u32 as f32,
            elevation,
            azimuth,
            strength,
            vivid as u32 as f32,
            relief,
            relief_width,
            height_max as f32,
        ];
        if self.lighting != Some(lighting) {
            self.lighting = Some(lighting);
            self.dirty_coarse();
        }
        let params = [
            0.,
            0.,
            scale as f32,
            width as f32,
            height as f32,
            grid as u32 as f32,
            shadows as u32 as f32,
            elevation.to_radians().tan(),
            height_max as f32 / 16.,
            0.,
            0.,
            0.,
            strength,
            vivid as u32 as f32,
            direction[0],
            direction[1],
            relief,
            relief_width,
            0.,
            0.,
        ];
        let mut uniforms = Vec::<u8>::with_capacity(80 + self.tiles.len() * 48);
        uniforms.extend_from_slice(bytemuck::cast_slice(&params));
        for key in self.tiles.keys() {
            let span = key.span();
            let x = key.x as f64 * span - cx;
            let z = key.z as f64 * span - cz;
            let opacity = self
                .cut
                .iter()
                .find(|e| e.key == *key)
                .map_or(1., |e| e.opacity);
            let uniform = DrawUniform {
                origin: [x as f32, z as f32, (1u32 << key.level) as f32, opacity],
                key: [key.level as i32, key.x, key.z, 0],
                world: relative_bounds(*key, bounds),
            };
            uniforms.extend_from_slice(bytemuck::bytes_of(&uniform));
        }
        let staging = buffer(
            &self.device,
            "LOD frame uniform upload",
            &uniforms,
            wgpu::BufferUsages::COPY_SRC,
        );
        encoder.copy_buffer_to_buffer(&staging, 0, &self.params, 0, 80);
        for (i, tile) in self.tiles.values().enumerate() {
            encoder.copy_buffer_to_buffer(&staging, 80 + i as u64 * 48, &tile.origin, 0, 48);
        }
        self.upload_peak = self.upload_peak.max(self.cpu_bytes() + uniforms.capacity());
        self.retire(vec![Resource::Buffer(staging)], vec![]);
        let shade_key = match prepared {
            Some((Kind::Tile, key)) if key.level > 0 => Some(key),
            Some(_) => None,
            None => self
                .cut
                .iter()
                .find(|e| self.tiles.get(&e.key).is_some_and(|t| t.dirty))
                .map(|e| e.key)
                .or_else(|| {
                    self.tiles
                        .iter()
                        .rev()
                        .find(|(_, t)| t.dirty)
                        .map(|(key, _)| *key)
                }),
        };
        if let Some(key) = shade_key {
            self.shade_one(key, &mut encoder);
        }
        let target = self.target.as_ref().unwrap();
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("LOD premultiplied additive cut"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &target.view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                ..Default::default()
            });
            pass.set_pipeline(&self.terrain);
            pass.set_bind_group(0, &self.global, &[]);
            for e in &self.cut {
                let span = e.key.span();
                let x = e.key.x as f64 * span - cx;
                let z = e.key.z as f64 * span - cz;
                let half_x = width as f64 / scale * 0.5;
                let half_z = height as f64 / scale * 0.5;
                if e.opacity == 0.
                    || x > half_x
                    || x + span < -half_x
                    || z > half_z
                    || z + span < -half_z
                {
                    continue;
                }
                if let Some(tile) = self.tiles.get(&e.key).filter(|t| t.ready) {
                    pass.set_bind_group(1, &tile.group, &[]);
                    pass.draw(0..6, 0..1);
                }
            }
        }
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("LOD resolve"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: output,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                ..Default::default()
            });
            pass.set_pipeline(&self.resolve);
            pass.set_bind_group(0, &target.group, &[]);
            pass.draw(0..3, 0..1);
        }
        let readback = {
            let mut state = self.feedback_state.lock().unwrap();
            let index = state.busy.iter().position(|busy| !busy);
            if let Some(index) = index {
                state.busy[index] = true;
            }
            index
        };
        if let Some(index) = readback {
            encoder.copy_buffer_to_buffer(&self.feedback, 0, &self.readbacks[index], 0, 16);
        }
        self.submit(encoder);
        if let Some(index) = readback {
            self.read_feedback(index, self.submitted);
        }
        Ok(true)
    }
}

fn page_hash(x: i32, z: i32) -> usize {
    (((x as u32).wrapping_mul(1664525) ^ (z as u32).wrapping_mul(1013904223)) & 255) as usize
}
fn relative_bounds(key: Key, bounds: [i32; 4]) -> [f32; 4] {
    let size = (1u32 << key.level) as f64;
    let x = key.x as f64 * key.span();
    let z = key.z as f64 * key.span();
    [
        (bounds[0] as f64 - x) / size,
        (bounds[1] as f64 - z) / size,
        (bounds[2] as f64 - x) / size,
        (bounds[3] as f64 - z) / size,
    ]
    .map(|v| v as f32)
}
fn copy_edge(
    encoder: &mut wgpu::CommandEncoder,
    source: &wgpu::Texture,
    src: [u32; 2],
    dest: &wgpu::Texture,
    dst: [u32; 2],
    size: [u32; 2],
) {
    encoder.copy_texture_to_texture(
        wgpu::TexelCopyTextureInfo {
            texture: source,
            mip_level: 0,
            origin: wgpu::Origin3d {
                x: src[0],
                y: src[1],
                z: 0,
            },
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::TexelCopyTextureInfo {
            texture: dest,
            mip_level: 0,
            origin: wgpu::Origin3d {
                x: dst[0],
                y: dst[1],
                z: 0,
            },
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::Extent3d {
            width: size[0],
            height: size[1],
            depth_or_array_layers: source
                .depth_or_array_layers()
                .min(dest.depth_or_array_layers()),
        },
    );
}

impl Drop for GpuLod {
    fn drop(&mut self) {
        // Explicit disposal ends the renderer's lifetime; pending native/browser
        // submissions retain their own references until completion.
        self.dummy.destroy();
        self.atlas.destroy();
    }
}

#[cfg(test)]
mod tests;
