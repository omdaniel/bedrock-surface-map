# Paged GPU Renderer

`surface_gpu::lod::GpuLod` and the WASM `LodRenderer` provide the paged rendering
path alongside the legacy `Renderer`. Both use the same material atlas sampling,
tint, water, overlay, grading, lighting composition and edge-relief WGSL functions.
No legacy browser interface is removed.

## Browser API

```typescript
const renderer = await LodRenderer.create(canvas, materials, atlasBitmap);
renderer.set_world(new Int32Array([minX, minZ, maxX, maxZ]), maxHeight16);
renderer.add_tile(level, x, z, words);   // Uint32Array, queued
renderer.add_height(level, x, z, words); // Uint32Array, queued
renderer.has_tile(level, x, z);         // prepared and submitted in queue order
renderer.has_height(level, x, z);
renderer.set_cut(new Float32Array([level, x, z, opacity /* ... */]));
renderer.render(cx, cz, physicalScale, width, height, grid, shadows,
  elevation, azimuth, strength, vivid, relief, reliefWidth);
renderer.update_materials(startMaterialId, values); // bounded Float32Array range
renderer.set_materials(values);                    // replace the full catalog
renderer.remove_tile(level, x, z);
renderer.remove_height(level, x, z);
renderer.is_lost();
renderer.simulate_device_loss();
renderer.free(); // wasm-bindgen generated
```

Bounds are exclusive block coordinates. `maxHeight16` is a signed integer height
in sixteenths of a block, not a block-height float. Set the world before rendering.
Camera coordinates and physical scale are f64. The caller sizes the canvas and
supplies physical pixels per block; there is no implicit DPR multiplication.
Per-tile origins and bounds are computed relative to the camera/tile in f64 before
GPU conversion. Cut entries are unique keys with finite opacity in [0,1], and
must name prepared tiles. Float32 cut keys must be exactly representable integers.

Tile side is 128 samples; `(level,x,z)` has origin
`(x,z) * (128 << level)`, with levels 0 through 16. Level zero detail has eight
u32 words per sample: signed height/16, material, tint, overlay, depth, support,
overlay height, coverage (0 unknown, 1 present, 2 empty, 3 outside).
Coarse tiles have six packed words per sample, as specified by the core LOD codec:
original/vivid u16 RGB in current working space, signed mean/min/max heights,
present/empty/unknown/water fractions and coverage flags. Level-zero height pages
have one packed height/flags word; other levels have mean/flags plus min/max.

Each successful `render` prepares at most one queued tile or height page, or
relights one coarse tile when no upload was prepared. A coarse tile's initial
color preparation and lighting are part of that same tile operation. Lighting
changes retain old shaded caches until each replacement is ready. No lighting
change rebuilds every tile synchronously. Cut opacities use additive premultiplied
accumulation and a final background resolve; the controller must partition the
cut and provide transition weights. Unknown and empty contributions cover the
background instead of discarding and exposing parent ground. Root fallback is
usable with approximate lighting before its height dependencies arrive.

Coarse colors are retained independently of detail cells. Original/vivid unlit
130x130 RGBA16F textures feed a cached 130x130 shaded texture; ordinary coarse
fragments only sample the cache and report its approximation status. Sibling
gutters are stitched after preparation and restored on removal. Fine fragments
sample the actual material atlas and compute shadows, edges and block grid.
The caller supplies atlas padding; two mip levels are generated on the GPU.
ImageBitmap upload uses `copy_external_image_to_texture`, without a WASM RGBA copy.

## Heights And Approximation

Height pages occupy a bounded GPU arena. Eight compute passes create each page's
128x128 leaves and seven max levels. CPU code retains a bounded page-key map, not
a global height window or CPU height pyramid. Seventeen 256-entry hash tables
look up pages at the requested draw level. Max nodes only prune traversal;
occlusion at a coarse leaf uses its mean, never its maximum. The scheduler owns
fine shadow-footprint admission; lookup never silently substitutes coarse pages
for missing exact pages. Rays terminate at dataset bounds or its maximum height.

`height_status()` returns flags from the latest completed feedback readback:
1 missing resident dependency, 2 dataset-unknown coverage, 4 traversal limit.
`missing_height_samples()`, `unknown_height_samples()` and
`exhausted_height_samples()` count affected evaluated fragments/cache samples.
They are asynchronous diagnostics, not a scheduler readiness proof. Coarse
cache status persists on subsequent draws. Missing or unknown height evidence
keeps the known surface color and reports approximate lighting; it does not
turn known ground into an unknown-surface checker. A root can therefore render
while the caller admits its height pages. At most three submissions and three
16-byte feedback readbacks are in flight through `render`; navigation never waits
on the GPU queue.

## Memory Contract

`gpu_bytes()` counts nominal bytes of every renderer-owned GPU buffer/texture,
including retired allocations and explicit staging buffers. `retiring_bytes()`
is a subset: separately allocated resources awaiting completion. Do not add it
to `gpu_bytes()`. Arena slots awaiting reuse are **not** retiring allocations;
`retiring_height_slots()` reports their occupancy separately. Driver allocation
overhead and browser-owned swapchain/ImageBitmap memory are not observable here.
The controller must account for its canvas, bitmap, JS arrays and total WASM
memory separately.

| Allocation | Nominal GPU Bytes |
| --- | ---: |
| Height arena, 128 slots | 22,369,280 |
| One height slot within that arena | 174,760 |
| All height page tables | 69,632 |
| Shared gutter-copy scratch buffer | 65,536 |
| Fine tile, including draw uniform | 524,336 |
| Coarse tile, including all caches and status | 798,868 |
| Temporary level-zero height upload/build/table | 135,296 |
| Temporary coarse height upload/build/table | 200,832 |
| Accumulation target | width * height * 8 |
| Frame uniform upload | 80 + residentTiles * 48 |

The arena is allocated with `create_buffer`, not a CPU zero vector. One slot is
reserved for atomic replacement: at most 127 height pages are resident and
`height_capacity()` reports the physical 128-slot capacity. The arena stays
allocated after page eviction. GPU retirement uses monotonically increasing
submission-completion serials; slots and old resources survive until completion.
The callback captures only an atomic serial and dispatches `surface-lod-retired`.
Reading memory stats or the next render/admission reaps resources on the main
thread. This also wakes the controller when rendering has otherwise stopped.

`tile_bytes(level)` reports incremental tile allocation. `height_bytes(level)`
reports temporary height preparation allocation, since the arena is already
charged. `resize_bytes(width,height)` reports the entire new target size if a
resize is needed, zero otherwise; the old target remains charged until retirement.
These estimates exclude the small shared frame uniform upload above.

`cpu_bytes()` reports queued payload capacities and Rust metadata estimates;
`upload_peak_bytes()` records the largest observed Rust payload/metadata upload
footprint. Neither claims to measure total committed WASM memory. Inputs are
copied once from the caller's typed array into the bounded Rust upload queue and
released after preparation. The queue holds at most 2 MiB; draw cuts and resident
draw tiles are capped at 128. `pending_tiles()`/`pending_uploads()` count queued
uploads. `pending_preparations()` also counts dirty coarse lighting caches.
`pending_submissions()` counts submissions awaiting completion. Keep upload
reservations until preparation is acknowledged; a single outstanding controller
upload can use an empty upload queue plus `has_tile`/`has_height` as its acknowledgement.
Multiple overlapping revisions require controller serialization; no per-version
acknowledgement API is provided. The final GPU allocation guard is 200,000,000 bytes.

## Verification

Run `cargo test --locked -p surface-gpu` on a machine with a native wgpu adapter,
and `cargo clippy --locked -p surface-gpu --target wasm32-unknown-unknown -- -D warnings`.
Tests use only a generated checker atlas and synthetic height/color pages.
Native validation is not a browser performance measurement. Chrome coarse/fine
navigation, memory recordings and scheduling measurements belong to the parent
controller integration gate.
