//! Bounded, independently resident draw tiles and GPU-built height pages.
//!
//! See `LOD.md` for the browser contract and the memory ledger's scope.
use std::collections::{BTreeMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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
const CACHE_STATUS_BYTES: u64 = 9 * 4;
const MAX_QUEUE_BYTES: usize = 2 * 1024 * 1024;
const MAX_UPDATE_BYTES: u64 = 1024 * 1024;
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
pub const FEEDBACK_REDUCE: &str = include_str!("lod_feedback.wgsl");
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
    fn parent(self) -> Self {
        Self {
            level: self.level + 1,
            x: self.x.div_euclid(2),
            z: self.z.div_euclid(2),
        }
    }
}

// West, east, north, south, then NW, NE, SW, SE corners. Integer page arithmetic works at negative and
// distant origins; no world-coordinate f32 comparison participates in adjacency.
fn adjacent_edge(finer: Key, coarser: Key) -> Option<usize> {
    if coarser.level != finer.level + 1 {
        return None;
    }
    let x = finer.x as i64;
    let z = finer.z as i64;
    let cx = coarser.x as i64 * 2;
    let cz = coarser.z as i64 * 2;
    if z >= cz && z < cz + 2 {
        if x == cx + 2 {
            return Some(0);
        }
        if x + 1 == cx {
            return Some(1);
        }
    }
    if x >= cx && x < cx + 2 {
        if z == cz + 2 {
            return Some(2);
        }
        if z + 1 == cz {
            return Some(3);
        }
    }
    if x == cx + 2 && z == cz + 2 {
        return Some(4);
    }
    if x + 1 == cx && z == cz + 2 {
        return Some(5);
    }
    if x == cx + 2 && z + 1 == cz {
        return Some(6);
    }
    if x + 1 == cx && z + 1 == cz {
        return Some(7);
    }
    None
}

fn band_rect(band: usize) -> [f64; 4] {
    match band {
        0 => [0., 0., 2., 128.],
        1 => [126., 0., 128., 128.],
        2 => [0., 0., 128., 2.],
        3 => [0., 126., 128., 128.],
        4 => [0., 0., 2., 2.],
        5 => [126., 0., 128., 2.],
        6 => [0., 126., 2., 128.],
        _ => [126., 126., 128., 128.],
    }
}

struct Boundary {
    parent: Key,
    weights: [f32; 8],
    neighbors: [Option<Key>; 8],
}
impl Boundary {
    fn sources(&self, key: Key, view: View) -> Vec<Key> {
        let mut sources = Vec::new();
        for (band, _) in self.weights.iter().enumerate().filter(|(_, w)| **w > 0.) {
            let rect = band_rect(band);
            // A half-parent-sample filter footprint extends one finer sample
            // across a parent border. Only those visible gutter sources relight.
            for dx in [0, if key.x.rem_euclid(2) == 0 { -1 } else { 1 }] {
                for dz in [0, if key.z.rem_euclid(2) == 0 { -1 } else { 1 }] {
                    let strip = |d| match d {
                        -1 => [0., 1.],
                        1 => [127., 128.],
                        _ => [0., 128.],
                    };
                    let sx = strip(dx);
                    let sz = strip(dz);
                    let clipped = [
                        rect[0].max(sx[0]),
                        rect[1].max(sz[0]),
                        rect[2].min(sx[1]),
                        rect[3].min(sz[1]),
                    ];
                    if clipped[0] < clipped[2]
                        && clipped[1] < clipped[3]
                        && view.local_visible(key, clipped)
                    {
                        let source = Key {
                            level: self.parent.level,
                            x: self.parent.x + dx,
                            z: self.parent.z + dz,
                        };
                        if !sources.contains(&source) {
                            sources.push(source);
                        }
                    }
                }
            }
        }
        sources
    }
}
fn cut_boundaries(cut: &[CutEntry]) -> BTreeMap<Key, Boundary> {
    let mut boundaries = BTreeMap::new();
    for finer in cut
        .iter()
        .filter(|e| e.opacity > 0. && e.key.level < MAX_LEVEL)
    {
        let mut boundary = Boundary {
            parent: finer.key.parent(),
            weights: [0.; 8],
            neighbors: [None; 8],
        };
        for coarser in cut.iter().filter(|e| e.opacity > 0.) {
            if let Some(edge) = adjacent_edge(finer.key, coarser.key) {
                boundary.weights[edge] = coarser.opacity;
                boundary.neighbors[edge] = Some(coarser.key);
            }
        }
        if boundary.neighbors.iter().any(Option::is_some) {
            boundaries.insert(finer.key, boundary);
        }
    }
    boundaries
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CutEntry {
    pub key: Key,
    pub opacity: f32,
}

#[derive(Default)]
struct Topology {
    entries: Vec<CutEntry>,
    boundaries: BTreeMap<Key, Boundary>,
}
impl Topology {
    fn new(entries: Vec<CutEntry>, opaque: bool) -> Result<Self> {
        ensure!(
            entries.len() <= MAX_TILES,
            "LOD draw cut exceeds 128 entries"
        );
        let mut keys = std::collections::BTreeSet::new();
        for entry in &entries {
            Key::new(entry.key.level, entry.key.x, entry.key.z)?;
            ensure!(
                entry.opacity.is_finite() && (0.0..=1.0).contains(&entry.opacity),
                "invalid cut opacity"
            );
            ensure!(
                !opaque || entry.opacity == 1.,
                "transition cuts require unit opacity"
            );
            ensure!(keys.insert(entry.key), "duplicate tile in draw cut");
        }
        for (i, a) in entries.iter().enumerate().filter(|(_, e)| e.opacity > 0.) {
            let a_rect = key_rect(a.key);
            for b in entries[..i].iter().filter(|e| e.opacity > 0.) {
                let b_rect = key_rect(b.key);
                let dx = a_rect[2].min(b_rect[2]) - a_rect[0].max(b_rect[0]);
                let dz = a_rect[3].min(b_rect[3]) - a_rect[1].max(b_rect[1]);
                let overlap = dx > 0 && dz > 0;
                ensure!(
                    !opaque || !overlap,
                    "transition cut has overlapping tiles: {:?}, {:?}",
                    a.key,
                    b.key
                );
                ensure!(
                    overlap || dx < 0 || dz < 0 || a.key.level.abs_diff(b.key.level) <= 1,
                    "LOD cut is not 2:1 balanced at an edge or corner: {:?}, {:?}",
                    a.key,
                    b.key
                );
            }
        }
        Ok(Self {
            boundaries: cut_boundaries(&entries),
            entries,
        })
    }
    fn cpu_bytes(&self) -> usize {
        self.entries.capacity() * std::mem::size_of::<CutEntry>()
            + self.boundaries.len() * (std::mem::size_of::<(Key, Boundary)>() + 128)
    }
}

// Exact block bounds also cover level-16 keys beyond the f32 world range.
fn key_rect(key: Key) -> [i64; 4] {
    let span = 128i64 << key.level;
    let x = key.x as i64 * span;
    let z = key.z as i64 * span;
    [x, z, x + span, z + span]
}

#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
#[repr(C)]
struct DrawUniform {
    origin: [f32; 4],
    key: [i32; 4],
    world: [f32; 4],
    edges: [f32; 4],
    corners: [f32; 4],
}
const DRAW_BYTES: u64 = std::mem::size_of::<DrawUniform>() as u64;

#[derive(Clone, Copy, PartialEq)]
struct View {
    camera: [f64; 2],
    scale: f64,
    width: u32,
    height: u32,
}
impl View {
    fn new(camera: [f64; 2], scale: f64, width: u32, height: u32) -> Result<Self> {
        ensure!(
            camera.into_iter().all(f64::is_finite)
                && scale.is_finite()
                && scale > 0.
                && scale <= 65536.,
            "invalid LOD camera"
        );
        Ok(Self {
            camera,
            scale,
            width,
            height,
        })
    }
    fn origin(self, key: Key) -> [f64; 2] {
        [
            key.x as f64 * key.span() - self.camera[0],
            key.z as f64 * key.span() - self.camera[1],
        ]
    }
    fn visible(self, key: Key) -> bool {
        self.local_visible(key, [0., 0., 128., 128.])
    }
    fn local_visible(self, key: Key, rect: [f64; 4]) -> bool {
        if self.width == 0 || self.height == 0 {
            return false;
        }
        let [x, z] = self.origin(key);
        let sample = (1u32 << key.level) as f64;
        let half_x = self.width as f64 / self.scale * 0.5;
        let half_z = self.height as f64 / self.scale * 0.5;
        x + rect[0] * sample < half_x
            && x + rect[2] * sample > -half_x
            && z + rect[1] * sample < half_z
            && z + rect[3] * sample > -half_z
    }
}

fn texture_bytes(texture: &wgpu::Texture) -> u64 {
    let (bw, bh) = texture.format().block_dimensions();
    let block = texture
        .format()
        .block_copy_size(None)
        .expect("LOD textures use copyable color formats") as u64;
    (0..texture.mip_level_count())
        .map(|mip| {
            (texture.width() >> mip).max(1).div_ceil(bw) as u64
                * (texture.height() >> mip).max(1).div_ceil(bh) as u64
                * texture.depth_or_array_layers() as u64
                * texture.sample_count() as u64
                * block
        })
        .sum()
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
    edge_source: Option<wgpu::BindGroup>,
    shade_group: Option<wgpu::BindGroup>,
    cached_status: Option<wgpu::Buffer>,
    dirty: bool,
    ready: bool,
    lighting_epoch: u64,
}
impl Tile {
    fn bytes(&self) -> u64 {
        self.data.size()
            + self.origin.size()
            + self.color.as_ref().map_or(0, texture_bytes)
            + self.lit.as_ref().map_or(0, texture_bytes)
            + self.cached_status.as_ref().map_or(0, wgpu::Buffer::size)
    }
    fn resources(self) -> Vec<Resource> {
        let mut resources = vec![Resource::Buffer(self.data), Resource::Buffer(self.origin)];
        if let Some(t) = self.color {
            resources.push(Resource::Texture(t));
        }
        if let Some(t) = self.lit {
            resources.push(Resource::Texture(t));
        }
        if let Some(b) = self.cached_status {
            resources.push(Resource::Buffer(b));
        }
        resources
    }
    fn needs_shade(&self, epoch: u64) -> bool {
        self.color.is_some() && (self.dirty || self.lighting_epoch != epoch)
    }
}
enum Resource {
    Buffer(wgpu::Buffer),
    Texture(wgpu::Texture),
}
impl Resource {
    fn bytes(&self) -> u64 {
        match self {
            Self::Buffer(b) => b.size(),
            Self::Texture(t) => texture_bytes(t),
        }
    }
    fn destroy(self) {
        match self {
            Self::Buffer(b) => b.destroy(),
            Self::Texture(t) => t.destroy(),
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
    Surface,
}
impl Kind {
    fn tile(self) -> bool {
        self != Self::Height
    }
    fn height(self) -> bool {
        self != Self::Tile
    }
}
struct Pending {
    key: Key,
    kind: Kind,
    words: Vec<u32>,
    height_words: Vec<u32>,
    chunks: Vec<[i32; 2]>,
}
impl Pending {
    fn cpu_bytes(&self) -> usize {
        (self.words.capacity() + self.height_words.capacity()) * 4 + self.chunks.capacity() * 8
    }
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
        texture_bytes(&self.texture)
    }
}
#[derive(Default)]
struct FeedbackState {
    busy: [bool; 3],
    ready: [bool; 3],
    serials: [u64; 3],
    revisions: [u64; 3],
    serial: u64,
    revision: u64,
    values: [u32; 4],
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = performance, js_name = now)]
    fn submission_now_ms() -> f64;
}

#[cfg_attr(target_arch = "wasm32", derive(Default))]
struct SubmissionClock {
    #[cfg(not(target_arch = "wasm32"))]
    origin: std::time::Instant,
}
#[cfg(not(target_arch = "wasm32"))]
impl Default for SubmissionClock {
    fn default() -> Self {
        Self {
            origin: std::time::Instant::now(),
        }
    }
}
impl SubmissionClock {
    fn now_ms(&self) -> f64 {
        #[cfg(target_arch = "wasm32")]
        {
            submission_now_ms()
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            self.origin.elapsed().as_secs_f64() * 1000.
        }
    }
}

#[derive(Clone, Copy)]
struct SubmissionTime {
    first: u64,
    last: u64,
    started_ms: f64,
}
#[derive(Default)]
struct SubmissionTimes {
    entries: [Option<SubmissionTime>; 3],
}
impl SubmissionTimes {
    fn record(&mut self, serial: u64, completed: u64, now_ms: f64) {
        let mut retained = [None; 3];
        let mut count = 0;
        for entry in self.entries.iter().flatten().filter(|e| e.last > completed) {
            retained[count] = Some(*entry);
            count += 1;
        }
        if count < retained.len() {
            retained[count] = Some(SubmissionTime {
                first: serial,
                last: serial,
                started_ms: now_ms,
            });
        } else {
            // Non-frame submissions are not throttled. Preserve bounded storage
            // and the oldest timestamp; partial completion makes this an upper bound.
            retained[2].as_mut().unwrap().last = serial;
        }
        self.entries = retained;
    }
    fn oldest(&self, completed: u64, now_ms: f64) -> (f64, bool) {
        self.entries
            .iter()
            .flatten()
            .find(|e| e.last > completed)
            .map_or((0., true), |e| {
                ((now_ms - e.started_ms).max(0.), e.first > completed)
            })
    }
}

/// Queue progress sampled without polling the device or changing submission policy.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SubmissionStats {
    /// Renderer-local serial, including atlas, material, removal and frame work.
    pub submitted_serial: u64,
    /// Highest serial acknowledged by on_submitted_work_done, not a GPU timestamp.
    pub completed_serial: u64,
    /// Monotonic age of the oldest unacknowledged submission; zero when idle/disposed.
    pub oldest_in_flight_age_ms: f64,
    /// False means age is an upper bound after >3 outstanding submissions forced
    /// timestamp coalescing and the first part of that range completed.
    pub oldest_in_flight_age_exact: bool,
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
    feedback_reduce: wgpu::ComputePipeline,
    feedback_group: wgpu::BindGroup,
    global: wgpu::BindGroup,
    shade_global: wgpu::BindGroup,
    feedback: wgpu::Buffer,
    feedback_lanes: wgpu::Buffer,
    readbacks: [wgpu::Buffer; 3],
    feedback_state: Arc<Mutex<FeedbackState>>,
    params: wgpu::Buffer,
    material_buffer: wgpu::Buffer,
    material_count: usize,
    atlas: wgpu::Texture,
    atlas_view: wgpu::TextureView,
    atlas_sampler: wgpu::Sampler,
    coarse_sampler: wgpu::Sampler,
    dummy: wgpu::Texture,
    dummy_view: wgpu::TextureView,
    empty_status: wgpu::Buffer,
    dummy_edge_source: wgpu::BindGroup,
    gutter_scratch: wgpu::Buffer,
    page_table: wgpu::Buffer,
    nodes: wgpu::Buffer,
    capacity: usize,
    free_slots: Vec<usize>,
    tiles: BTreeMap<Key, Tile>,
    heights: BTreeMap<Key, usize>,
    pending: VecDeque<Pending>,
    cuts: [Topology; 2],
    transition: Option<f32>,
    target: Option<Target>,
    retirement: Mutex<Retirement>,
    completed: Arc<AtomicU64>,
    submitted: u64,
    submission_clock: SubmissionClock,
    submission_times: SubmissionTimes,
    upload_peak: usize,
    world: Option<([i32; 4], i32)>,
    lighting: Option<[f32; 8]>,
    lighting_epoch: u64,
    view: Option<View>,
    active: Arc<AtomicBool>,
    feedback_revision: u64,
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
        ensure!(
            atlas.format() == wgpu::TextureFormat::Rgba8Unorm
                && atlas.dimension() == wgpu::TextureDimension::D2
                && atlas.depth_or_array_layers() == 1
                && atlas.sample_count() == 1
                && (1..=3).contains(&atlas.mip_level_count())
                && atlas.usage().contains(
                    wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::STORAGE_BINDING
                ),
            "LOD atlas must be a single-layer RGBA8 texture with one to three GPU-writable mips"
        );
        ensure!(
            texture_bytes(&atlas) <= 64 * 1024 * 1024,
            "LOD atlas exceeds 64 MiB"
        );
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
        let feedback_reduce = crate::compute_pipeline(
            &device,
            "LOD coverage feedback reduction",
            FEEDBACK_REDUCE,
            "reduce",
        );
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
            wgpu::BufferUsages::STORAGE
                | wgpu::BufferUsages::COPY_DST
                | wgpu::BufferUsages::COPY_SRC,
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
            &[0u8; CACHE_STATUS_BYTES as usize],
            wgpu::BufferUsages::STORAGE,
        );
        let dummy_edge_source =
            Self::bind_edge_source(&device, &terrain, &dummy_view, &empty_status);
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
        let feedback_lanes = buffer(
            &device,
            "striped LOD coverage feedback",
            &[0u8; 128 * 16],
            wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        );
        let feedback_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("LOD coverage reduction"),
            layout: &feedback_reduce.get_bind_group_layout(0),
            entries: &[entry(0, &feedback_lanes), entry(1, &feedback)],
        });
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
            &feedback_lanes,
        );
        let shade_global = Self::bind_shade(
            &device,
            &coarse_shade,
            &params,
            &page_table,
            &nodes,
            &feedback_lanes,
        );
        let mut this = Self {
            device,
            queue,
            terrain,
            resolve,
            coarse_build,
            coarse_shade,
            height_leaves,
            height_reduce,
            feedback_reduce,
            feedback_group,
            global,
            shade_global,
            feedback,
            feedback_lanes,
            readbacks,
            feedback_state: Arc::default(),
            params,
            material_buffer,
            material_count: materials.len() / 12,
            atlas,
            atlas_view,
            atlas_sampler,
            coarse_sampler,
            dummy,
            dummy_view,
            empty_status,
            dummy_edge_source,
            gutter_scratch,
            page_table,
            nodes,
            capacity,
            free_slots: (0..capacity).rev().collect(),
            tiles: BTreeMap::new(),
            heights: BTreeMap::new(),
            pending: VecDeque::new(),
            cuts: Default::default(),
            transition: None,
            target: None,
            retirement: Mutex::default(),
            completed: Arc::default(),
            submitted: 0,
            submission_clock: SubmissionClock::default(),
            submission_times: SubmissionTimes::default(),
            upload_peak: 0,
            world: None,
            lighting: None,
            lighting_epoch: 0,
            view: None,
            active: Arc::new(AtomicBool::new(true)),
            feedback_revision: 1,
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
    fn bind_edge_source(
        device: &wgpu::Device,
        pipeline: &wgpu::RenderPipeline,
        view: &wgpu::TextureView,
        status: &wgpu::Buffer,
    ) -> wgpu::BindGroup {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("LOD parent edge source"),
            layout: &pipeline.get_bind_group_layout(2),
            entries: &[tex_entry(0, view), entry(1, status)],
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
            &self.feedback_lanes,
        );
        self.shade_global = Self::bind_shade(
            &self.device,
            &self.coarse_shade,
            &self.params,
            &self.page_table,
            &self.nodes,
            &self.feedback_lanes,
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
        self.submission_times.record(
            serial,
            self.completed.load(Ordering::Acquire),
            self.submission_clock.now_ms(),
        );
        self.queue.submit([encoder.finish()]);
        let completed = self.completed.clone();
        #[cfg(target_arch = "wasm32")]
        let active = self.active.clone();
        self.queue.on_submitted_work_done(move || {
            completed.fetch_max(serial, Ordering::Release);
            #[cfg(target_arch = "wasm32")]
            if !active.load(Ordering::Acquire) {
                return;
            }
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
        self.allocation_bytes()[0]
    }
    /// One coherent nominal allocation snapshot: total, retirement, tiles,
    /// height arena, presentation target, other shared resources.
    pub fn allocation_bytes(&self) -> [u64; 6] {
        if self.is_disposed() {
            return [0; 6];
        }
        self.reap();
        let shared = self.params.size()
            + self.material_buffer.size()
            + texture_bytes(&self.atlas)
            + texture_bytes(&self.dummy)
            + self.feedback.size()
            + self.feedback_lanes.size()
            + self.readbacks.iter().map(wgpu::Buffer::size).sum::<u64>()
            + self.empty_status.size()
            + self.gutter_scratch.size()
            + self.page_table.size();
        let retired = self.retirement.lock().unwrap().allocated_bytes();
        let tiles = self.tiles.values().map(Tile::bytes).sum::<u64>();
        let arena = self.nodes.size();
        let target = self.target.as_ref().map_or(0, Target::bytes);
        [
            shared + retired + tiles + arena + target,
            retired,
            tiles,
            arena,
            target,
            shared,
        ]
    }
    pub fn cpu_bytes(&self) -> usize {
        // Rust payload allocations and conservatively charged map metadata. The
        // external ImageBitmap and caller's typed arrays remain caller-owned.
        let retirement = self.retirement.lock().unwrap();
        let retired_metadata = retirement.entries.capacity() * std::mem::size_of::<Retired>()
            + retirement.free_slots.capacity() * std::mem::size_of::<usize>()
            + retirement
                .entries
                .iter()
                .map(|r| {
                    r.resources.capacity() * std::mem::size_of::<Resource>()
                        + r.slots.capacity() * std::mem::size_of::<usize>()
                })
                .sum::<usize>();
        self.pending.iter().map(Pending::cpu_bytes).sum::<usize>()
            + self.pending.capacity() * std::mem::size_of::<Pending>()
            + self.cuts.iter().map(Topology::cpu_bytes).sum::<usize>()
            + self.tiles.len() * (std::mem::size_of::<(Key, Tile)>() + 128)
            + self.heights.len() * (std::mem::size_of::<(Key, usize)>() + 128)
            + self.free_slots.capacity() * std::mem::size_of::<usize>()
            + std::mem::size_of::<Self>()
            + retired_metadata
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
        if self.is_disposed() {
            return 0;
        }
        self.reap();
        self.submitted - self.completed.load(Ordering::Acquire)
    }
    /// A coherent progress snapshot. Serial advancement distinguishes slow
    /// acknowledgements from a stalled acknowledgement stream; age alone does
    /// not establish whether the GPU or callback delivery is stalled. Uses
    /// Instant natively and performance.now() on WASM, never wall-clock time.
    /// Disposal returns zero serials/age and exact=true, even after late callbacks.
    pub fn submission_stats(&self) -> SubmissionStats {
        if self.is_disposed() {
            return SubmissionStats {
                oldest_in_flight_age_exact: true,
                ..Default::default()
            };
        }
        let completed_serial = self.completed.load(Ordering::Acquire);
        let (oldest_in_flight_age_ms, oldest_in_flight_age_exact) = self
            .submission_times
            .oldest(completed_serial, self.submission_clock.now_ms());
        SubmissionStats {
            submitted_serial: self.submitted,
            completed_serial,
            oldest_in_flight_age_ms,
            oldest_in_flight_age_exact,
        }
    }
    pub fn pending_tiles(&self) -> usize {
        self.pending.len()
    }
    pub fn pending_preparations(&self) -> usize {
        self.pending.len() + self.preparation_keys().len()
    }
    fn cut_weights(&self) -> [f32; 2] {
        self.transition.map_or([1., 0.], |t| [1. - t, t])
    }
    fn active_cuts(&self) -> impl Iterator<Item = (&Topology, f32)> {
        self.cuts
            .iter()
            .zip(self.cut_weights())
            .filter(|(_, w)| *w > 0.)
    }
    fn in_world(&self, key: Key) -> bool {
        self.world.is_none_or(|(bounds, _)| {
            let rect = key_rect(key);
            rect[0] < bounds[2] as i64
                && rect[2] > bounds[0] as i64
                && rect[1] < bounds[3] as i64
                && rect[3] > bounds[1] as i64
        })
    }
    fn preparation_keys(&self) -> Vec<Key> {
        let mut keys = Vec::new();
        let Some(view) = self.view else {
            return keys;
        };
        let mut add = |key| {
            if self
                .tiles
                .get(&key)
                .is_some_and(|t| t.needs_shade(self.lighting_epoch))
                && !keys.contains(&key)
            {
                keys.push(key);
            }
        };
        for (cut, _) in self.active_cuts() {
            for (key, boundary) in &cut.boundaries {
                for source in boundary.sources(*key, view) {
                    if source == boundary.parent || self.in_world(source) {
                        add(source);
                    }
                }
            }
            for entry in &cut.entries {
                if entry.opacity > 0. && view.visible(entry.key) {
                    add(entry.key);
                }
            }
        }
        keys
    }
    pub fn pending_uploads(&self) -> usize {
        self.pending.len()
    }
    pub fn height_status(&self) -> [u32; 4] {
        if self.is_disposed() {
            return [8, 0, 0, 0];
        }
        self.reap_feedback();
        let state = self.feedback_state.lock().unwrap();
        let mut values = state.values;
        if state.revision != self.feedback_revision {
            values[0] |= 8;
        }
        values
    }
    pub fn height_status_ready(&self) -> bool {
        self.height_status()[0] & 8 == 0
    }
    pub fn lighting_epoch(&self) -> u64 {
        self.lighting_epoch
    }
    pub fn tile_lighting_epoch(&self, key: Key) -> u64 {
        self.tiles.get(&key).map_or(0, |t| t.lighting_epoch)
    }
    pub fn world(&self) -> Option<([i32; 4], i32)> {
        self.world
    }
    pub fn is_disposed(&self) -> bool {
        !self.active.load(Ordering::Acquire)
    }
    fn ensure_active(&self) -> Result<()> {
        ensure!(
            !self.is_disposed(),
            "LOD renderer disposed; reconstruct before use"
        );
        Ok(())
    }
    pub fn height_capacity(&self) -> usize {
        self.capacity
    }
    /// Admission capacity for new pages, excluding queued uploads, quarantined
    /// slots and the one slot reserved for atomic replacement.
    pub fn available_height_slots(&self) -> usize {
        if self.is_disposed() {
            return 0;
        }
        self.reap();
        let queued = self.pending.iter().filter(|p| p.kind.height()).count();
        let new_pages = self
            .pending
            .iter()
            .filter(|p| p.kind.height() && !self.heights.contains_key(&p.key))
            .count();
        let free = self.free_slots.len() + self.retirement.lock().unwrap().free_slots.len();
        free.saturating_sub(queued + 1).min(
            self.capacity
                .saturating_sub(1 + self.heights.len() + new_pages),
        )
    }
    pub fn set_world(&mut self, bounds: [i32; 4], height_max: i32) -> Result<()> {
        self.ensure_active()?;
        ensure!(
            bounds[0] < bounds[2]
                && bounds[1] < bounds[3]
                && (i16::MIN as i32..=i16::MAX as i32).contains(&height_max),
            "invalid LOD world bounds or quantized height maximum"
        );
        if self.world != Some((bounds, height_max)) {
            self.world = Some((bounds, height_max));
            self.dirty_coarse();
            self.feedback_revision += 1;
        }
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
            SAMPLES as u64 * 32 + DRAW_BYTES
        } else {
            SAMPLES as u64 * 24 + DRAW_BYTES + COARSE_BYTES + SHADED_BYTES + CACHE_STATUS_BYTES
        }
    }
    /// Incremental GPU reservation for temporary upload/build buffers. Page slots
    /// belong to the separately charged fixed arena, including during retirement.
    pub fn height_bytes(&self, level: u32) -> u64 {
        SAMPLES as u64 * if level == 0 { 4 } else { 8 } + 8 * 16 + (TABLE_ENTRIES * 16) as u64
    }
    /// Additional GPU bytes while old resources remain charged. Zero patches
    /// means a full replacement; 1..64 means complete chunks of an exact tile.
    /// Height slots already belong to the fixed arena and are not charged twice.
    pub fn surface_update_bytes(&self, level: u32, patch_count: u32) -> Result<u64> {
        ensure!(level <= MAX_LEVEL, "LOD level must be 0..16");
        ensure!(
            patch_count <= 64 && (patch_count == 0 || level == 0),
            "LOD patches require 1..64 exact chunks"
        );
        let bytes = self.height_bytes(level)
            + if patch_count == 0 {
                self.tile_bytes(level)
            } else {
                u64::from(patch_count) * 256 * 32
            };
        ensure!(bytes <= MAX_UPDATE_BYTES, "LOD surface job exceeds 1 MiB");
        Ok(bytes)
    }
    fn pending_bytes(&self, next: &Pending) -> u64 {
        match next.kind {
            Kind::Tile => self.tile_bytes(next.key.level),
            Kind::Height => self.height_bytes(next.key.level),
            Kind::Surface => self
                .surface_update_bytes(next.key.level, next.chunks.len() as u32)
                .expect("validated surface job"),
        }
    }
    fn validate_update_key(key: Key) -> Result<()> {
        Key::new(key.level, key.x, key.z)?;
        surface_core::lod::TileKey::new(key.level as u8, key.x, key.z)?;
        Ok(())
    }
    fn validate_detail_columns(&self, words: &[u32]) -> Result<()> {
        for c in words.chunks_exact(8) {
            ensure!(
                c[1] < self.material_count as u32
                    && c[3] < self.material_count as u32
                    && c[5] < self.material_count as u32,
                "LOD material ID outside catalog"
            );
            ensure!(
                c[7] <= 3
                    && i16::try_from(c[0] as i32).is_ok()
                    && i16::try_from(c[6] as i32).is_ok()
                    && (c[7] != 1 || c[0] as i32 != i16::MIN as i32)
                    && c[2] <= 0xffffff
                    && c[4] <= 384,
                "invalid detail height, coverage or attributes"
            );
        }
        Ok(())
    }
    fn detail_height(c: &[u32]) -> u32 {
        use surface_core::lod::{EMPTY, OUTSIDE, PRESENT, UNKNOWN_FLAG, WATER};
        let flags = match c[7] {
            1 => PRESENT | if c[4] > 0 { WATER } else { 0 },
            2 => EMPTY,
            3 => OUTSIDE,
            _ => UNKNOWN_FLAG,
        };
        let height = if c[7] == 1 {
            c[0] as u16
        } else {
            i16::MIN as u16
        };
        u32::from(height) | (u32::from(flags) << 16)
    }
    fn validate_update_heights(key: Key, words: &[u32]) -> Result<()> {
        use surface_core::lod::{ALL_FLAGS, PRESENT, WATER};
        let stride = if key.level == 0 { 1 } else { 2 };
        ensure!(
            words.len() == SAMPLES * stride,
            "LOD height word count mismatch"
        );
        for s in words.chunks_exact(stride) {
            let flags = (s[0] >> 16) as u16;
            let mean = s[0] as i16;
            let (min, max) = if stride == 1 {
                (mean, mean)
            } else {
                (s[1] as i16, (s[1] >> 16) as i16)
            };
            ensure!(
                flags != 0
                    && flags & !ALL_FLAGS == 0
                    && (flags & WATER == 0 || flags & PRESENT != 0)
                    && (stride == 2 || (flags & !WATER).count_ones() == 1),
                "invalid LOD height coverage"
            );
            ensure!(
                if flags & PRESENT != 0 {
                    min != i16::MIN && min <= mean && mean <= max
                } else {
                    [mean, min, max] == [i16::MIN; 3]
                },
                "invalid LOD height extrema"
            );
        }
        Ok(())
    }
    /// Queues one indivisible surface/height job, superseding older queued work
    /// for this key. Existing resources remain visible until its frame executes.
    pub fn replace_surface(
        &mut self,
        key: Key,
        words: Vec<u32>,
        height_words: Vec<u32>,
    ) -> Result<()> {
        self.ensure_active()?;
        Self::validate_update_key(key)?;
        self.validate_words(key, Kind::Tile, &words)?;
        Self::validate_update_heights(key, &height_words)?;
        if key.level == 0 {
            self.validate_detail_columns(&words)?;
            for (c, h) in words.chunks_exact(8).zip(&height_words) {
                ensure!(Self::detail_height(c) == *h, "surface/height mismatch");
            }
        } else {
            for (c, h) in words.chunks_exact(6).zip(height_words.chunks_exact(2)) {
                surface_core::lod::SummarySample {
                    original: [c[0] as u16, (c[0] >> 16) as u16, c[1] as u16],
                    vivid: [(c[1] >> 16) as u16, c[2] as u16, (c[2] >> 16) as u16],
                    mean_height: c[3] as i16,
                    min_height: (c[3] >> 16) as i16,
                    max_height: c[4] as i16,
                    present_fraction: (c[4] >> 16) as u8,
                    empty_fraction: (c[4] >> 24) as u8,
                    unknown_fraction: c[5] as u8,
                    water_fraction: (c[5] >> 8) as u8,
                    flags: (c[5] >> 16) as u16,
                }
                .validate()?;
                ensure!(
                    h[0] == (c[3] & 0xffff) | (c[5] & 0xffff0000)
                        && h[1] == (c[3] >> 16) | (c[4] << 16),
                    "surface/height mismatch"
                );
            }
        }
        self.enqueue_pending(Pending {
            key,
            kind: Kind::Surface,
            words,
            height_words,
            chunks: vec![],
        })
    }
    /// Absolute chunk coordinates, in the same order as 256*8-word payloads.
    /// The caller supplies the complete current height page; changed columns
    /// must match it. Other height samples are validated but remain caller-owned.
    pub fn patch_chunks(
        &mut self,
        key: Key,
        chunks: Vec<[i32; 2]>,
        words: Vec<u32>,
        height_words: Vec<u32>,
    ) -> Result<()> {
        self.ensure_active()?;
        Self::validate_update_key(key)?;
        ensure!(
            key.level == 0 && self.has_tile(key),
            "LOD patch requires a resident exact tile"
        );
        ensure!(
            (1..=64).contains(&chunks.len()),
            "LOD patches require 1..64 chunks"
        );
        ensure!(
            words.len() == chunks.len() * 256 * 8,
            "LOD chunk word count mismatch"
        );
        let mut seen = 0u64;
        for [cx, cz] in &chunks {
            ensure!(
                cx.div_euclid(8) == key.x && cz.div_euclid(8) == key.z,
                "chunk outside exact tile"
            );
            let bit = 1 << (cz.rem_euclid(8) * 8 + cx.rem_euclid(8));
            ensure!(seen & bit == 0, "duplicate LOD chunk patch");
            seen |= bit;
        }
        self.validate_detail_columns(&words)?;
        Self::validate_update_heights(key, &height_words)?;
        for ([cx, cz], chunk) in chunks.iter().zip(words.chunks_exact(256 * 8)) {
            let x = cx.rem_euclid(8) as usize * 16;
            let z = cz.rem_euclid(8) as usize * 16;
            for (i, c) in chunk.chunks_exact(8).enumerate() {
                ensure!(
                    Self::detail_height(c) == height_words[(z + i / 16) * SIDE + x + i % 16],
                    "patched surface/height mismatch"
                );
            }
        }
        ensure!(
            !self.pending.iter().any(|p| p.key == key),
            "LOD patch key already queued; drain or replace it"
        );
        self.enqueue_pending(Pending {
            key,
            kind: Kind::Surface,
            words,
            height_words,
            chunks,
        })
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
        self.ensure_active()?;
        Key::new(key.level, key.x, key.z)?;
        self.validate_words(key, kind, &words)?;
        ensure!(
            !self
                .pending
                .iter()
                .any(|p| p.key == key && p.kind == Kind::Surface),
            "cannot split a queued surface update"
        );
        self.enqueue_pending(Pending {
            key,
            kind,
            words,
            height_words: vec![],
            chunks: vec![],
        })
    }
    fn enqueue_pending(&mut self, next: Pending) -> Result<()> {
        let key = next.key;
        let replaced =
            |p: &Pending| p.key == key && (next.kind == Kind::Surface || p.kind == next.kind);
        let kept = || self.pending.iter().filter(|p| !replaced(p));
        let queued: usize = kept().map(Pending::cpu_bytes).sum();
        ensure!(
            queued + next.cpu_bytes() <= MAX_QUEUE_BYTES,
            "LOD upload queue full"
        );
        if next.kind.tile() {
            let additions = kept()
                .filter(|p| p.kind.tile() && !self.tiles.contains_key(&p.key))
                .count();
            ensure!(
                self.tiles.contains_key(&key) || self.tiles.len() + additions < MAX_TILES,
                "LOD tile slots full"
            );
        }
        if next.kind.height() {
            let additions = kept()
                .filter(|p| p.kind.height() && !self.heights.contains_key(&p.key))
                .count();
            // One slot remains available to prepare a replacement atomically.
            ensure!(
                self.heights.contains_key(&key)
                    || self.heights.len() + additions < self.capacity - 1,
                "LOD height slots full"
            );
            self.reap();
            let free = self.free_slots.len() + self.retirement.lock().unwrap().free_slots.len();
            let queued = kept().filter(|p| p.kind.height()).count();
            let reserve = usize::from(!self.heights.contains_key(&key));
            ensure!(free > queued + reserve, "LOD height slots await retirement");
        }
        ensure!(
            self.gpu_bytes() + self.pending_bytes(&next) <= MAX_GPU_BYTES,
            "LOD upload exceeds GPU budget"
        );
        self.upload_peak = self.upload_peak.max(self.cpu_bytes() + next.cpu_bytes());
        self.pending.retain(|p| !replaced(p));
        self.pending.push_back(next);
        Ok(())
    }
    pub fn add_tile(&mut self, key: Key, words: Vec<u32>) -> Result<()> {
        self.enqueue(key, Kind::Tile, words)
    }
    pub fn add_height(&mut self, key: Key, words: Vec<u32>) -> Result<()> {
        self.enqueue(key, Kind::Height, words)
    }
    pub fn set_cut(&mut self, cut: Vec<CutEntry>) -> Result<()> {
        self.ensure_active()?;
        if self.transition.is_some() || self.cuts[0].entries != cut {
            let topology = Topology::new(cut, false)?;
            self.validate_residency(&topology)?;
            self.feedback_revision += 1;
            self.cuts = [topology, Topology::default()];
            self.transition = None;
        }
        Ok(())
    }
    /// Each topology is nonoverlapping, unit opacity and edge/corner 2:1 balanced.
    /// Repeating the same ordered keys changes only the external fade weight.
    pub fn set_transition(
        &mut self,
        previous: Vec<CutEntry>,
        next: Vec<CutEntry>,
        progress: f32,
    ) -> Result<()> {
        self.ensure_active()?;
        ensure!(
            (0.0..=1.0).contains(&progress),
            "invalid LOD transition progress"
        );
        ensure!(
            previous.len() + next.len() <= MAX_TILES,
            "LOD transition exceeds 128 combined draws"
        );
        if self.transition.is_none()
            || self.cuts[0].entries != previous
            || self.cuts[1].entries != next
        {
            let cuts = [Topology::new(previous, true)?, Topology::new(next, true)?];
            for cut in &cuts {
                self.validate_residency(cut)?;
            }
            self.cuts = cuts;
            self.feedback_revision += 1;
        }
        if self.transition != Some(progress) {
            self.transition = Some(progress);
            self.feedback_revision += 1;
        }
        Ok(())
    }
    fn validate_residency(&self, cut: &Topology) -> Result<()> {
        for entry in &cut.entries {
            ensure!(
                self.has_tile(entry.key),
                "draw cut includes an unprepared tile: {:?}",
                entry.key
            );
        }
        for boundary in cut.boundaries.values() {
            ensure!(
                self.has_tile(boundary.parent),
                "mixed LOD edge requires a prepared resident parent: {:?}",
                boundary.parent
            );
        }
        Ok(())
    }
    /// Pure residency planning: accepts an opaque topology before its tiles exist.
    /// Includes every boundary parent and only visibly sampled in-world gutters.
    #[allow(clippy::too_many_arguments)]
    pub fn required_sources(
        &self,
        entries: Vec<CutEntry>,
        cx: f64,
        cz: f64,
        scale: f64,
        width: u32,
        height: u32,
    ) -> Result<Vec<Key>> {
        self.ensure_active()?;
        ensure!(
            self.world.is_some(),
            "set_world is required before LOD dependency planning"
        );
        let view = View::new([cx, cz], scale, width, height)?;
        let topology = Topology::new(entries, true)?;
        let mut keys = std::collections::BTreeSet::new();
        for (key, boundary) in &topology.boundaries {
            keys.insert(boundary.parent);
            for source in boundary.sources(*key, view) {
                if self.in_world(source) {
                    keys.insert(source);
                }
            }
        }
        // One parent and its three possible side/corner siblings per finer key.
        debug_assert!(keys.len() <= MAX_TILES * 4);
        Ok(keys.into_iter().collect())
    }
    pub fn set_materials(&mut self, values: &[f32]) -> Result<()> {
        self.ensure_active()?;
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
            wgpu::BufferUsages::STORAGE
                | wgpu::BufferUsages::COPY_DST
                | wgpu::BufferUsages::COPY_SRC,
        );
        let old = std::mem::replace(&mut self.material_buffer, new);
        self.material_count = values.len() / 12;
        self.feedback_revision += 1;
        self.rebind();
        self.retire(vec![Resource::Buffer(old)], vec![]);
        // No tile regeneration: fine appearance reads the catalog dynamically;
        // coarse summaries are versioned/replaced by the caller with the catalog.
        self.submit(self.device.create_command_encoder(&Default::default()));
        Ok(())
    }
    /// Append zero-initialized material slots without a CPU catalog copy. Fill
    /// them using update_materials before introducing surfaces with the new IDs.
    pub fn grow_materials(&mut self, count: u32) -> Result<()> {
        self.ensure_active()?;
        ensure!(
            (self.material_count..=65536).contains(&(count as usize)),
            "material growth must preserve IDs and stay within 65536 entries"
        );
        if count as usize == self.material_count {
            return Ok(());
        }
        let bytes = u64::from(count) * 48;
        ensure!(
            self.gpu_bytes() + bytes <= MAX_GPU_BYTES,
            "LOD material growth exceeds GPU budget"
        );
        let new = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("grown LOD materials"),
            size: bytes,
            usage: wgpu::BufferUsages::STORAGE
                | wgpu::BufferUsages::COPY_SRC
                | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let mut encoder = self.device.create_command_encoder(&Default::default());
        encoder.copy_buffer_to_buffer(
            &self.material_buffer,
            0,
            &new,
            0,
            self.material_buffer.size(),
        );
        let old = std::mem::replace(&mut self.material_buffer, new);
        self.material_count = count as usize;
        self.rebind();
        self.retire(vec![Resource::Buffer(old)], vec![]);
        self.feedback_revision += 1;
        self.submit(encoder);
        Ok(())
    }
    pub fn update_materials(&mut self, start: u32, values: &[f32]) -> Result<()> {
        self.ensure_active()?;
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
        self.feedback_revision += 1;
        self.submit(encoder);
        Ok(())
    }
    pub fn remove_tile(&mut self, key: Key) {
        if self.is_disposed() {
            return;
        }
        self.pending.retain(|p| !p.kind.tile() || p.key != key);
        if let Some(tile) = self.tiles.remove(&key) {
            self.feedback_revision += 1;
            if self.transition.is_none() {
                self.cuts[0].entries.retain(|e| e.key != key);
                self.cuts[0].boundaries = cut_boundaries(&self.cuts[0].entries);
            }
            self.retire(tile.resources(), vec![]);
            let mut encoder = self.device.create_command_encoder(&Default::default());
            self.reset_neighbor_gutters(key, &mut encoder);
            self.submit(encoder);
        }
    }
    pub fn remove_height(&mut self, key: Key) {
        if self.is_disposed() {
            return;
        }
        self.pending.retain(|p| !p.kind.height() || p.key != key);
        if let Some(slot) = self.heights.remove(&key) {
            self.feedback_revision += 1;
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
            wgpu::BufferUsages::STORAGE
                | wgpu::BufferUsages::COPY_DST
                | wgpu::BufferUsages::COPY_SRC,
        );
        let origin = buffer(
            &self.device,
            "LOD camera-relative tile",
            &[0u8; DRAW_BYTES as usize],
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
                &[0u8; CACHE_STATUS_BYTES as usize],
                wgpu::BufferUsages::STORAGE
                    | wgpu::BufferUsages::COPY_DST
                    | wgpu::BufferUsages::COPY_SRC,
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
        let edge_source = view.as_ref().map(|view| {
            Self::bind_edge_source(
                &self.device,
                &self.terrain,
                view,
                cached_status.as_ref().unwrap(),
            )
        });
        let tile = Tile {
            data,
            origin,
            color,
            lit,
            group,
            edge_source,
            shade_group,
            cached_status,
            dirty: key.level != 0,
            ready: key.level == 0,
            lighting_epoch: 0,
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
        if next.kind.height() && self.free_slots.is_empty() {
            return Ok(None);
        }
        let reservation = self.pending_bytes(next);
        ensure!(
            self.gpu_bytes() + reservation <= MAX_GPU_BYTES,
            "LOD GPU preparation exceeds 200 MB budget"
        );
        let next = self.pending.pop_front().unwrap();
        // The queue no longer owns these inputs, but they remain allocated
        // throughout preparation, including its bounded table scratch space.
        self.upload_peak = self
            .upload_peak
            .max(self.cpu_bytes() + next.cpu_bytes() + TABLE_ENTRIES * 16);
        match next.kind {
            Kind::Tile => self.prepare_tile(next.key, &next.words, encoder),
            Kind::Height => self.prepare_height(next.key, &next.words, encoder),
            Kind::Surface => {
                self.prepare_height(next.key, &next.height_words, encoder);
                if next.chunks.is_empty() {
                    self.prepare_tile(next.key, &next.words, encoder);
                } else {
                    self.prepare_chunks(next.key, &next.chunks, &next.words, encoder);
                }
                self.dirty_coarse();
            }
        }
        Ok(Some((next.kind, next.key)))
    }
    fn prepare_chunks(
        &mut self,
        key: Key,
        chunks: &[[i32; 2]],
        words: &[u32],
        encoder: &mut wgpu::CommandEncoder,
    ) {
        let staging = buffer(
            &self.device,
            "LOD complete chunk rows",
            bytemuck::cast_slice(words),
            wgpu::BufferUsages::COPY_SRC,
        );
        let tile = &self.tiles[&key];
        for (i, [cx, cz]) in chunks.iter().enumerate() {
            let x = cx.rem_euclid(8) as u64 * 16;
            let z = cz.rem_euclid(8) as u64 * 16;
            for row in 0..16 {
                encoder.copy_buffer_to_buffer(
                    &staging,
                    i as u64 * 8192 + row * 512,
                    &tile.data,
                    ((z + row) * 128 + x) * 32,
                    512,
                );
            }
        }
        self.retire(vec![Resource::Buffer(staging)], vec![]);
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
                if let Some(status) = &tile.cached_status {
                    encoder.clear_buffer(status, gutter_status_offset(-dx, -dz), Some(4));
                }
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
        tile.lighting_epoch = self.lighting_epoch;
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
                    .filter(|t| !t.needs_shade(self.lighting_epoch) && t.ready)
                else {
                    continue;
                };
                let Some(neighbor) = &tile.lit else {
                    continue;
                };
                // Copy only each tile's own status, never recursively accumulated
                // gutter flags. A replaced/removed neighbor can then clear its slot.
                let current_status = self.tiles[&key].cached_status.as_ref().unwrap();
                let neighbor_status = tile.cached_status.as_ref().unwrap();
                encoder.copy_buffer_to_buffer(
                    neighbor_status,
                    0,
                    current_status,
                    gutter_status_offset(dx, dz),
                    4,
                );
                encoder.copy_buffer_to_buffer(
                    current_status,
                    0,
                    neighbor_status,
                    gutter_status_offset(-dx, -dz),
                    4,
                );
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
            self.retire(vec![Resource::Texture(old.texture)], vec![]);
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
    fn read_feedback(&self, index: usize, serial: u64, revision: u64) {
        let state = self.feedback_state.clone();
        let active = self.active.clone();
        self.readbacks[index]
            .slice(..)
            .map_async(wgpu::MapMode::Read, move |result| {
                if !active.load(Ordering::Acquire) {
                    return;
                }
                let mut state = state.lock().unwrap();
                state.ready[index] = result.is_ok();
                state.busy[index] = result.is_ok();
                state.serials[index] = serial;
                state.revisions[index] = revision;
                drop(state);
                #[cfg(target_arch = "wasm32")]
                if let (Some(window), Ok(event)) = (
                    web_sys::window(),
                    web_sys::Event::new("surface-lod-retired"),
                ) {
                    let _ = window.dispatch_event(&event);
                }
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
                    state.revision = state.revisions[index];
                }
                drop(mapped);
            }
            self.readbacks[index].unmap();
            state.ready[index] = false;
            state.busy[index] = false;
        }
    }
    fn validate_visible_sources(&self, view: View) -> Result<()> {
        for (cut, _) in self.active_cuts() {
            for entry in &cut.entries {
                ensure!(
                    entry.opacity == 0. || !view.visible(entry.key) || self.has_tile(entry.key),
                    "active LOD transition tile was removed: {:?}",
                    entry.key
                );
            }
            for (key, boundary) in &cut.boundaries {
                for source in boundary.sources(*key, view) {
                    ensure!(
                        (source != boundary.parent && !self.in_world(source))
                            || self.has_tile(source),
                        "mixed LOD edge for {:?} requires resident parent/gutter source {:?}",
                        key,
                        source
                    );
                }
            }
        }
        Ok(())
    }
    fn draw_uniform(
        &self,
        key: Key,
        opacity: f32,
        boundary: Option<&Boundary>,
        view: View,
        shade_key: Option<Key>,
        bounds: [i32; 4],
    ) -> DrawUniform {
        let [x, z] = view.origin(key);
        let tile = &self.tiles[&key];
        let weights = boundary.map_or([0.; 8], |b| b.weights);
        let parent_stale = boundary.is_some_and(|b| {
            b.sources(key, view).into_iter().any(|k| {
                (k == b.parent || self.in_world(k))
                    && shade_key != Some(k)
                    && self
                        .tiles
                        .get(&k)
                        .is_none_or(|t| t.needs_shade(self.lighting_epoch))
            })
        });
        DrawUniform {
            origin: [x as f32, z as f32, (1u32 << key.level) as f32, opacity],
            key: [
                key.level as i32,
                key.x,
                key.z,
                (if tile.needs_shade(self.lighting_epoch) && shade_key != Some(key) {
                    8
                } else {
                    0
                }) | if parent_stale { 16 } else { 0 },
            ],
            world: relative_bounds(key, bounds),
            edges: weights[..4].try_into().unwrap(),
            corners: weights[4..].try_into().unwrap(),
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
        self.ensure_active()?;
        let view = View::new([cx, cz], scale, width, height)?;
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
        if self.view != Some(view) {
            self.view = Some(view);
            self.feedback_revision += 1;
        }
        if self.lighting != Some(lighting) {
            self.lighting = Some(lighting);
            self.lighting_epoch += 1;
            self.feedback_revision += 1;
        }
        self.reap_feedback();
        if self.pending_submissions() >= 3 {
            return Ok(false);
        }
        self.validate_visible_sources(view)?;
        let draw_count: usize = self
            .active_cuts()
            .map(|(cut, _)| {
                cut.entries
                    .iter()
                    .filter(|e| e.opacity > 0. && view.visible(e.key))
                    .count()
            })
            .sum();
        let upload_bytes = 80 + (draw_count as u64 + 1) * DRAW_BYTES;
        let prepare_bytes = self
            .pending
            .front()
            .map_or(0, |next| self.pending_bytes(next));
        ensure!(
            self.gpu_bytes() + self.resize_bytes(width, height) + prepare_bytes + upload_bytes
                <= MAX_GPU_BYTES,
            "LOD frame exceeds 200 MB GPU budget"
        );
        self.resize(width, height)?;
        let mut encoder = self.device.create_command_encoder(&Default::default());
        let prepared = self.prepare_one(&mut encoder)?;
        let shade_key = match prepared {
            Some((Kind::Tile | Kind::Surface, key)) if key.level > 0 => Some(key),
            Some(_) => None,
            None => self.preparation_keys().first().copied(),
        };
        if prepared.is_some() || shade_key.is_some() {
            self.feedback_revision += 1;
        }
        encoder.clear_buffer(&self.feedback_lanes, 0, None);
        let direction = surface_core::sun_direction(azimuth);
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
        let mut uniforms = Vec::<u8>::with_capacity(
            80 + (draw_count + usize::from(shade_key.is_some())) * DRAW_BYTES as usize,
        );
        uniforms.extend_from_slice(bytemuck::cast_slice(&params));
        if let Some(key) = shade_key {
            let uniform = self.draw_uniform(key, 1., None, view, shade_key, bounds);
            uniforms.extend_from_slice(bytemuck::bytes_of(&uniform));
        }
        let mut draws: [Vec<(Key, u64)>; 2] = Default::default();
        for ((cut, weight), draws) in self.cuts.iter().zip(self.cut_weights()).zip(&mut draws) {
            if weight == 0. {
                continue;
            }
            for e in cut
                .entries
                .iter()
                .filter(|e| e.opacity > 0. && view.visible(e.key))
            {
                draws.push((e.key, uniforms.len() as u64));
                let uniform = self.draw_uniform(
                    e.key,
                    e.opacity * weight,
                    cut.boundaries.get(&e.key),
                    view,
                    shade_key,
                    bounds,
                );
                uniforms.extend_from_slice(bytemuck::bytes_of(&uniform));
            }
        }
        let staging = buffer(
            &self.device,
            "LOD frame uniform upload",
            &uniforms,
            wgpu::BufferUsages::COPY_SRC,
        );
        encoder.copy_buffer_to_buffer(&staging, 0, &self.params, 0, 80);
        if let Some(key) = shade_key {
            encoder.copy_buffer_to_buffer(&staging, 80, &self.tiles[&key].origin, 0, DRAW_BYTES);
            self.shade_one(key, &mut encoder);
        }
        let target = self.target.as_ref().unwrap();
        for (index, (cut, draws)) in self.cuts.iter().zip(&draws).enumerate() {
            if index > 0 && draws.is_empty() {
                continue;
            }
            // Shared tile keys may have different boundaries in the two cuts.
            // Ordered copies between passes preserve both using the same buffers.
            for (key, offset) in draws {
                encoder.copy_buffer_to_buffer(
                    &staging,
                    *offset,
                    &self.tiles[key].origin,
                    0,
                    DRAW_BYTES,
                );
            }
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("LOD premultiplied additive cut"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &target.view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: if index == 0 {
                            wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT)
                        } else {
                            wgpu::LoadOp::Load
                        },
                        store: wgpu::StoreOp::Store,
                    },
                })],
                ..Default::default()
            });
            pass.set_pipeline(&self.terrain);
            pass.set_bind_group(0, &self.global, &[]);
            for (key, _) in draws {
                if let Some(tile) = self.tiles.get(key).filter(|t| t.ready) {
                    pass.set_bind_group(1, &tile.group, &[]);
                    let source = cut
                        .boundaries
                        .get(key)
                        .and_then(|b| self.tiles.get(&b.parent))
                        .and_then(|t| t.edge_source.as_ref())
                        .unwrap_or(&self.dummy_edge_source);
                    pass.set_bind_group(2, source, &[]);
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
        self.upload_peak = self.upload_peak.max(
            self.cpu_bytes()
                + uniforms.capacity()
                + draws
                    .iter()
                    .map(|d| d.capacity() * std::mem::size_of::<(Key, u64)>())
                    .sum::<usize>(),
        );
        self.retire(vec![Resource::Buffer(staging)], vec![]);
        self.reduce_feedback(&mut encoder);
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
            self.read_feedback(index, self.submitted, self.feedback_revision);
        }
        Ok(true)
    }

    fn reduce_feedback(&self, encoder: &mut wgpu::CommandEncoder) {
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some("LOD coverage feedback reduction"),
            ..Default::default()
        });
        pass.set_pipeline(&self.feedback_reduce);
        pass.set_bind_group(0, &self.feedback_group, &[]);
        pass.dispatch_workgroups(1, 1, 1);
    }

    /// Explicit release without waiting for a failed device's queue. Native
    /// callers may share the device; only this renderer's resources are destroyed.
    pub fn dispose(&mut self) {
        if !self.active.swap(false, Ordering::AcqRel) {
            return;
        }
        self.submission_times = SubmissionTimes::default();
        self.pending = VecDeque::new();
        self.cuts = Default::default();
        self.transition = None;
        self.heights.clear();
        self.free_slots = Vec::new();
        for tile in std::mem::take(&mut self.tiles).into_values() {
            for resource in tile.resources() {
                resource.destroy();
            }
        }
        if let Some(target) = self.target.take() {
            target.texture.destroy();
        }
        let mut retirement = self.retirement.lock().unwrap();
        for retired in std::mem::take(&mut retirement.entries) {
            for resource in retired.resources {
                resource.destroy();
            }
        }
        retirement.free_slots = Vec::new();
        for b in [
            &self.params,
            &self.material_buffer,
            &self.feedback,
            &self.feedback_lanes,
            &self.page_table,
            &self.nodes,
            &self.empty_status,
            &self.gutter_scratch,
        ] {
            b.destroy();
        }
        for b in &self.readbacks {
            b.destroy();
        }
        self.atlas.destroy();
        self.dummy.destroy();
    }
}

impl Drop for GpuLod {
    fn drop(&mut self) {
        self.dispose();
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

fn gutter_status_offset(dx: i32, dz: i32) -> u64 {
    let i = (dz + 1) * 3 + dx + 1;
    (if i < 4 { i + 1 } else { i }) as u64 * 4
}

#[cfg(test)]
mod tests;
