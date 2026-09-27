# Paged GPU Renderer

`surface_gpu::lod::GpuLod` and the WASM `LodRenderer` provide the paged rendering
path alongside the legacy `Renderer`. Both use the same material atlas sampling,
tint, water, overlay, grading, lighting composition and edge-relief WGSL functions.
No legacy browser interface is removed.

## Browser API

```typescript
const renderer = await LodRenderer.create(canvas, materials, atlasBitmap);
renderer.set_world(new Int32Array([minX, minZ, maxX, maxZ]), maxHeight16);
renderer.add_tile(level, x, z, words); // Uint32Array, queued
renderer.add_height(level, x, z, words); // Uint32Array, queued
renderer.replace_surface(level, x, z, words, heightWords); // atomic queued pair
renderer.patch_chunks(x, z, chunkCoordinates, words, heightWords);
renderer.surface_update_bytes(level, patchCount); // incremental GPU reservation
renderer.has_tile(level, x, z); // prepared and submitted in queue order
renderer.has_height(level, x, z);
renderer.set_cut(new Float32Array([level, x, z, opacity /* ... */]));
renderer.set_transition(
  new Float32Array([oldLevel, oldX, oldZ /* ... */]),
  new Float32Array([newLevel, newX, newZ /* ... */]),
  progress,
);
const sources = renderer.required_sources(
  topologyKeyTriples,
  cx,
  cz,
  physicalScale,
  width,
  height,
); // Int32Array triples
const presented = renderer.render(
  cx,
  cz,
  physicalScale,
  width,
  height,
  grid,
  shadows,
  elevation,
  azimuth,
  strength,
  vivid,
  relief,
  reliefWidth,
);
const needsAnotherFrame = renderer.needs_frame();
renderer.update_materials(startMaterialId, values); // bounded Float32Array range
renderer.set_materials(values); // replace the full catalog
renderer.grow_materials(materialCount); // preserve existing GPU IDs
renderer.remove_tile(level, x, z);
renderer.remove_height(level, x, z);
renderer.is_lost();
renderer.simulate_device_loss();
renderer.dispose(); // idempotent explicit release, suppresses old-device events
renderer.free(); // wasm-bindgen generated
```

Browser `render` returns `true` only when it submits terrain drawing and presents
the canvas. It returns `false` for a preparation-only submission, an idle call,
or a deferred presentation (queue backpressure, an unavailable surface, or a
zero-sized viewport). Neither result acknowledges GPU completion. When the
requested camera, viewport, grid, lighting, cut and displayed dependencies are
unchanged, queued work that does not change the presentation uses only GPU copy
and compute commands: it acquires no canvas texture and runs no terrain or
resolve pass. An idle call submits nothing. Visible surface replacements and
fine-height changes that can affect displayed shadows or relief stay in the
same submission as their presentation. Coarse height preparation can retain the
current canvas while affected displayed caches are relit one per submission,
then presents the completed batch once. `needs_frame()` remains true between
the last cache preparation and that final presentation. Only sampled surface
and gutter sources immediately invalidate presentation; a fine tile does not
sample its same-level surface neighbors. Coarse feedback still aggregates all
gutter status lanes: offscreen gutter-status changes invalidate feedback and
receive a coalesced final presentation, not a claim of completed coverage.
Navigation and lighting changes still draw available fallback content while refinement proceeds.
Native `GpuLod::render`, which receives an explicit output view, retains its
explicit presentation behavior; this automatic separation is the browser contract.

Call `needs_frame()` after `render` to decide whether to request another frame
for the latest requested view. It reports a dirty presentation, queued upload,
or displayed coarse-cache preparation; it is false for a disposed renderer or
without a nonzero requested viewport. It does not submit or poll the GPU, predict
future view changes, or report in-flight work as a reason to redraw. Request a
frame on actual input/content changes as well. Do not retry solely because
`render` returned `false`, or sustain an idle RAF loop until the queue drains.
Process `surface-lod-retired` notifications independently of frame scheduling
to refresh allocation accounting and resume admission after asynchronous work
completes, including after a preparation-only submission.

`replace_surface` queues one complete tile with its matching height page.
`patch_chunks` replaces 1–64 complete chunks in a resident level-zero tile;
`chunkCoordinates` is an `Int32Array` of chunk X/Z pairs, and `words` concatenates
their 256-column render records. The height input describes the complete updated
tile. Keys, duplicates, lengths and material bounds are validated before mutation.
Both operations prepare surface and height work in one command encoder, with a
maximum 1 MiB preparation job. Canceling queued work leaves resident data intact.
The caller commits matching CPU picking after submission and does not cancel an
already submitted patch as though it were an uninstalled tile.

`surface_update_bytes(level, 0)` reserves a full replacement; a positive count
reserves exact chunk patches. This is incremental GPU storage, not the encoded
response, WASM or CPU picking allocation. Existing resources and retirement stay
charged separately. Material growth copies existing GPU descriptors without a
full CPU/WASM catalog and retires the old allocation by submission serial.

Bounds are exclusive block coordinates. `maxHeight16` is a signed integer height
in sixteenths of a block, not a block-height float. Set the world before rendering.
Camera coordinates and physical scale are f64. The caller sizes the canvas and
supplies physical pixels per block; there is no implicit DPR multiplication.
Per-tile origins and bounds are computed relative to the camera/tile in f64 before
GPU conversion. Cut entries are unique keys with finite opacity in [0,1], and
must name prepared tiles. Float32 cut keys must be exactly representable integers.
Use `set_cut` for a stable cut; it also retains weighted entries for native
compositing fixtures. Use `set_transition(previous, next, progress)` for fades:
both arrays contain key triples, with implicit unit opacity. Each topology must
be nonoverlapping and edge/corner 2:1 balanced. Progress is finite in [0,1]; the
combined entry count is at most 128, including keys shared by both cuts. Native
`GpuLod::set_transition` takes two `Vec<CutEntry>` with every opacity equal to one.
Invalid input leaves the current cuts unchanged. Repeating the same ordered keys
reuses topology maps; only the external weights (1-progress, progress) change.
Each topology derives its own boundary bands, independent of the other topology
or its fade weight. The two contributions use ordered render passes into the
same accumulation target, followed by one resolve. There is no second framebuffer.
At progress zero/one only the contributing topology schedules lighting or requires
visible resources. Call `set_cut` at completion to release obsolete CPU topology.
`required_sources` validates one supplied unit-opacity topology without requiring
its tiles to be resident or changing the active cut. It returns sorted unique
Int32 key triples for every immediate boundary parent and visibly sampled
in-world parent-level gutter sibling, at most 512 keys for a 128-entry cut.
Query both transition topologies and union the dependencies before admission;
retain them through the fade. This query excludes draw tiles themselves and
height pages. Use the actual physical camera/viewport and world bounds; query
again when the topology or view changes, not just when progress changes.
Spatially adjacent cut members differing by one level use a two-finer-sample
edge band (one parent sample). `set_cut` discovers these 2:1 edges using integer
keys and requires the finer tile's immediate parent to be prepared/resident.
The parent is not another cut contribution: its shaded cache is sampled only
inside the band, using child parity and tile-local coordinates. Transition bands
have full spatial weight before the external fade multiplies the contribution.
Fine interiors remain exact;
unknown/empty/outside child cells and partially covered coarse samples do not
blend to parent ground. Retain required parents until the mixed edge leaves the
cut; removing one while its child remains visible produces an explicit render
error instead of sampling a blank placeholder. Visible in-world parent-level
gutter siblings must also be retained, even if they are not ancestors of any cut
entry; missing sources produce errors naming the child and source keys. Sources
entirely outside world bounds need no residency. Stale resident sources still
draw their previous cached color and report approximation until relit. Removing
an active transition tile does not silently delete it from the topology: rendering
fails until it is restored or the controller supplies a new valid topology.
Diagonal 2:1 neighbors use a two-by-two finer-sample corner patch with the product
of the two edge weights, meeting adjacent edge bands continuously. Keep the level
spread at a shared corner to at most one; unsupported within-cut edge/corner level
jumps are rejected, including by `set_cut`. The two transition topologies may
have a larger combined level spread because their boundaries remain independent.

Tile side is 128 samples; `(level,x,z)` has origin
`(x,z) * (128 << level)`, with levels 0 through 16. Level zero detail has eight
u32 words per sample: signed height/16, material, tint, overlay, depth, support,
overlay height, coverage (0 unknown, 1 present, 2 empty, 3 outside).
Coarse tiles have six packed words per sample, as specified by the core LOD codec:
original/vivid u16 RGB in current working space, signed mean/min/max heights,
present/empty/unknown/water fractions and coverage flags. Level-zero height pages
have one packed height/flags word; other levels have mean/flags plus min/max.

Each `render` call that submits work prepares at most one queued tile or height
page, or relights one coarse tile when no upload was prepared. This bound also
applies to preparation-only submissions. A coarse tile's initial
color preparation and lighting are part of that same tile operation. Lighting
changes retain old shaded caches until each replacement is ready. No lighting
change rebuilds every tile synchronously. Lighting epochs coalesce obsolete work:
only visible, positive-opacity cut members are relit, using the latest settings.
Off-cut and offscreen ancestors retain their old cache without sustaining RAF.
Visible mixed edge bands additionally schedule their immediate parent and the
coarser neighbor that supplies its gutter, even when that neighbor is just outside
the viewport. This includes other resident parent-level siblings when a visible
band samples their side/corner gutters. These dependencies are deduplicated and share the same one-cache
preparation limit. An interior-only view does not schedule offscreen edge bands.
`lighting_epoch()` and `tile_lighting_epoch(level,x,z)` expose these revisions;
height-dependency invalidation is tracked separately. Initial queued tile uploads
still prepare their cache before `has_tile` becomes true. Already submitted GPU
work is not canceled. Cut opacities use additive premultiplied
accumulation and a final background resolve; the controller supplies independently
partitioned cuts, never a weighted union of transition topologies. Unknown and empty contributions cover the
background instead of discarding and exposing parent ground. Root fallback is
usable with approximate lighting before its height dependencies arrive.

Coarse colors are retained independently of detail cells. Original/vivid unlit
130x130 RGBA16F textures feed a cached 130x130 shaded texture; ordinary coarse
fragments only sample the cache and report its approximation status. Sibling
gutters are stitched after preparation and restored on removal. Fine fragments
sample the actual material atlas and compute shadows, edges and block grid.
Gutters propagate the sibling's own height-status flags without recursive
contamination. Only equally current lighting caches are stitched. Mixed-level
2:1 edges blend toward these common parent/sibling samples. Parent-cache status
and stale edge dependencies propagate into height feedback. Level jumps larger
than one inside a topology are not given recursive blending.
The caller supplies atlas padding; two mip levels are generated on the GPU.
ImageBitmap upload uses `copy_external_image_to_texture`, without a WASM RGBA copy.

## Heights And Approximation

Height pages occupy a bounded GPU arena. Eight compute passes create each page's
128x128 leaves and seven max levels. CPU code retains a bounded page-key map, not
a global height window or CPU height pyramid. Seventeen 256-entry hash tables
look up pages at the requested draw level. Max nodes only prune traversal;
occlusion at a coarse leaf uses its mean, never its maximum. The scheduler owns
fine shadow-footprint admission. A missing page may inherit certified absence
from a covering ancestor cell: verified-empty remains empty, while unknown or
mixed unknown/empty coverage remains unknown. Any ancestor cell containing
known ground leaves the exact dependency missing; its mean or range never
substitutes for an exact height. Existing exact pages take precedence. Rays
terminate at dataset bounds or its maximum height.

`height_status()` returns flags from the latest completed feedback readback:
1 missing resident dependency, 2 dataset-unknown coverage, 4 traversal limit,
8 pending/unavailable feedback or stale visible lighting cache. Mutation of the
cut, camera, lighting or relevant resources invalidates feedback until a matching
readback completes. `height_status_ready()` is true only when bit 8 is absent;
it does not mean exact lighting when other flags are set. Initial/no-device
status is unavailable, never silently exact. Old nonzero flags are retained
while feedback is pending.
`missing_height_samples()`, `unknown_height_samples()` and
`exhausted_height_samples()` count affected evaluated fragments/cache samples.
They are asynchronous diagnostics, not a scheduler readiness proof. Diagnostic
writes use 128 fixed lanes and a GPU reduction pass that preserves
all flags and sample counts; the 2,048-byte lane buffer is charged as a shared
allocation. Coarse cache status persists on subsequent draws. Missing or unknown
height evidence
keeps the known surface color and reports approximate lighting; it does not
turn known ground into an unknown-surface checker. A root can therefore render
while the caller admits its height pages. Presentation and preparation-only
work share the same three-pending-submission admission cap through `render`.
At most three 16-byte feedback readbacks are in flight; preparation-only work
does not issue a presentation-feedback readback. Navigation never waits on the
GPU queue.

## Memory Contract

`gpu_bytes()` counts nominal bytes of every renderer-owned GPU buffer/texture,
including retired allocations and explicit staging buffers. `retiring_bytes()`
is a subset: separately allocated resources awaiting completion. Do not add it
to `gpu_bytes()`. Arena slots awaiting reuse are **not** retiring allocations;
`retiring_height_slots()` reports their occupancy separately. Driver allocation
overhead and browser-owned swapchain/ImageBitmap memory are not observable here.
The controller must account for its canvas, bitmap, JS arrays and total WASM
memory separately.
`allocation_stats()` returns a Float64Array snapshot in this order: total,
retiring, tile allocations, height arena, presentation target, other shared
allocations. The last five values sum to total. Buffers use their actual descriptor
sizes; textures use format block size, dimensions, layers, samples and mip count.
These are nominal resource bytes, not an estimate of driver heap overhead.

| Allocation                                     |                                                                       Nominal GPU Bytes |
| ---------------------------------------------- | --------------------------------------------------------------------------------------: |
| Height arena, 128 slots                        |                                                                              22,369,280 |
| One height slot within that arena              |                                                                                 174,760 |
| All height page tables                         |                                                                                  69,632 |
| Shared gutter-copy scratch buffer              |                                                                                  65,536 |
| Fine tile, including draw uniform              |                                                                                 524,368 |
| Coarse tile, including all caches and status   |                                                                                 798,932 |
| Temporary level-zero height upload/build/table |                                                                                 135,296 |
| Temporary coarse height upload/build/table     |                                                                                 200,832 |
| Accumulation target                            |                                                                      width * height * 8 |
| Frame uniform upload                           | 80 + visible contributing draws * 80 + (one cache preparation ? 80 : 0), at most 10,400 |

The arena is allocated with `create_buffer`, not a CPU zero vector. One slot is
reserved for atomic replacement: at most 127 height pages are resident and
`height_capacity()` reports the physical 128-slot capacity. The arena stays
allocated after page eviction. `available_height_slots()` is a read-only admission
query that first reaps completion, then excludes occupied and quarantined slots,
queued height uploads (including replacements), and the replacement reserve.
It reports availability for new pages; a replacement may use the reserved slot.
Admission also enforces this bound. GPU retirement uses monotonically increasing
submission-completion serials; slots and old resources survive until completion.
Every submission, including preparation-only work, registers the mandatory
asynchronous `on_submitted_work_done` callback with the same serial ledger as
presentation, atlas, material and removal work. The callback advances the
completed serial; in the browser it also dispatches `surface-lod-retired` while
the renderer is active. It captures only primitive shared state.
Reading memory stats or the next render/admission reaps resources on the main
thread. Completed feedback readbacks dispatch the same event. This also wakes the
controller when rendering has otherwise stopped. A successful queue submission,
`has_tile`/`has_height`, an empty upload queue, or `needs_frame() == false` is not
a completion acknowledgement and must not release quarantined slots or retired
resources early. Native callers must drive device polling for completion and
readback callbacks; the browser keeps completion asynchronous without blocking
its input/render loop.

Shadow traversal uses the same checked height lookup for current and parent
nodes. Each ray retains the coverage checks and representative-leaf tests;
page maxima only prune traversal.

The opt-in native diagnostic compares exact rays and query/step counts against
the legacy height-tree shader on the generated 1,024-square synthetic fixture:

```sh
npm run lod:fixture
SURFACE_SHADOW_SOURCE="$PWD/web/public/maps/lod-fixture/source" \
  cargo test -p surface-gpu diagnostic_shadow_traversal --locked \
  -- --ignored --nocapture
```

It requires a native GPU adapter and reports traversal counts, not frame rate or
GPU execution timestamps. Its temporary whole-fixture oracle is test-only;
the viewer does not allocate that height tree.

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
uploads. `pending_preparations()` also counts stale/dirty coarse lighting caches
in the visible positive-opacity cut of the latest requested view, not off-cut
or offscreen caches except the visible mixed-edge dependencies described above.
`pending_submissions()` counts submissions awaiting completion. Keep upload
reservations until preparation is acknowledged; a single outstanding controller
upload can use an empty upload queue plus `has_tile`/`has_height` as its submission
acknowledgement, including when `render` returns `false` after preparation-only
work. This permits matching CPU residency/picking integration; actual GPU
completion and retirement still require the asynchronous callback.
Multiple overlapping revisions require controller serialization; no per-version
acknowledgement API is provided. The final GPU allocation guard is 200,000,000 bytes.

## Device Lifecycle

`is_lost()` reports device loss; `simulate_device_loss()` marks it immediately and
destroys the device, exercising the same loss notification. The controller owns
recovery policy and replay: free the old renderer before creating a new one, then
restore world metadata, materials and a bounded root/cut/page working set. There
is no native automatic reconstruction or retained CPU copy of the world/atlas.
`dispose()` releases all owned allocations, pending payloads and retirement
entries without waiting for the queue; it is also called by `free()`. The browser
wrapper destroys its dedicated device. Disposal is idempotent, reports zero GPU
allocation and rejects further rendering/uploads. Per-instance active guards
suppress delayed loss, completion and readback events from disposed renderers.

## Verification

Run `cargo test --locked -p surface-gpu` on a machine with a native wgpu adapter,
and `cargo clippy --locked -p surface-gpu --target wasm32-unknown-unknown -- -D warnings`.
Tests use only a generated checker atlas and synthetic height/color pages.
Native validation is not a browser performance measurement. Chrome coarse/fine
navigation, memory recordings and scheduling measurements belong to the parent
controller integration gate.
The focused `tests/lod-preparation.spec.ts` browser regression exercises unchanged
height preparation, real view/lighting changes, atomic live picking integration,
retirement notifications/accounting and idle scheduling with synthetic pages.
Run it with `npx playwright test tests/lod-preparation.spec.ts`; full demo cold
refinement is a separate acceptance gate.
