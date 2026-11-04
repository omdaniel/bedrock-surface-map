# Planar renderer LOD interface

LOD pages use `surface_core::lod` keys and 128 × 128 samples. Their world span is
`128 * 2**level`. The existing renderer, camera, materials, lighting controls,
fine texture shader and legacy region/chunk calls remain shared.

- `decode_lod_surface(bytes, level, x, z, material_count)` accepts one bounded
  Zstd frame, validates its core codec, key and detail material IDs, and returns
  `Uint32Array`: eight words per level-zero detail sample or six per summary.
- `decode_lod_height(bytes, level, x, z)` validates the height page and returns
  mean heights in world blocks, with `-1000000` for missing samples.
- `add_lod_tile(level, x, z, words)` validates and uploads those words; the key
  includes the level, so parents and children can coexist. Upload does not shade.
  Replacing a resident reuses its allocation and retains its prepared texture.
- `remove_lod_tile(level, x, z)` releases that resident. It does not modify the cut.
- `set_lod_draw_tiles(Int32Array)` accepts `(level,x,z)` triples for full tiles.
- `set_lod_draw_cut(Int32Array)` accepts records of seven integers:
  `(level,x,z,min_x,min_z,max_x,max_z)`. Clips use half-open world bounds, must
  be nonempty and contained by the source tile, and cannot overlap other clips.
  A source may appear repeatedly with disjoint clips. Invalid replacement cuts
  leave the previous cut intact. Each draw intersects the viewport and scissors
  in physical pixels; shared clip edges partition pixel centers at fractional zoom.
- `prepare_lod_tiles(max_tiles)` shades at most that many dirty, eligible tiles,
  prioritizing selected sources, then other residents. It returns the number of
  dirty residents remaining. Zero performs no work. `lod_pending_tiles()` returns
  the same count without preparation.
- `lod_tile_ready(level,x,z)` reports whether the tile has a prepared texture and
  eligible heights. A dirty tile remains ready while its old texture is usable.
- `lod_tile_dirty(level,x,z)` reports pending shaded-texture preparation; invalid
  or missing keys return false. Exact fine fragments read uploaded cell records
  immediately, while overview fragments keep the previous prepared texture.
- `patch_lod_height(level,x,z,Float32Array)` patches a complete 128-square page of
  decoded block-unit heights into the existing window without allocating another
  field. The stride must equal `2**level`, the page must fit wholly inside the
  window, and its sample grid must align. Otherwise it returns false without
  writes. Invalid keys, wrong lengths and nonfinite samples throw, including for
  out-of-window pages. Success marks the height tree and all shaded tiles dirty;
  the next render or preparation rebuilds the tree before reading it. Upload a
  fine surface replacement and its matching height page before the next draw.

Calling either cut setter activates LOD mode; an empty cut draws no terrain.
Until then, `add_region`, `remove_region`, `patch_chunk` and legacy rendering keep
their existing behavior. `render()` updates camera and lighting, marks affected
LOD textures dirty, and draws prepared residents in the selected cut. It does
not regenerate LOD textures. Preparation uses settings from the latest `render()`;
schedule `prepare_lod_tiles(1)` or another small budget between renders. Newly
uploaded sources are not drawable until prepared. Use `lod_tile_ready` to retain
clipped parent coverage while finer sources become ready. Root retention (up to
four root pages), cut selection, fetch priority and eviction belong to the caller.

`create` and `set_height_window` accept power-of-two height strides through 65536.
Window extents must be divisible by that stride and contain at most 16M samples.
Level-zero LOD pages require a stride-one window covering their **full** world
footprint, even when their selected clip is smaller. Ineligible dirty fine pages
remain pending; the caller must replace/expand the window or evict those pages,
and should not spin waiting for their pending count to reach zero. Summary pages
can use a different-stride mean-height window; outside it, missing occluders and
relief neighbors cannot contribute lighting. No additional height pager exists.

Summary colors are core's pregraded original/vivid UNORM16 averages. The GPU pads
each six-word record with a zero and an explicit type marker to share the existing
32-byte `Cell` binding. Its six source words (including heights, fractions and
flags) stay unchanged; summary colors never become material IDs and are not graded
again. Coverage controls premultiplied color/alpha. Summary water fractions damp
sampled relief instead of inventing exact block edges.

`gpu_bytes()` counts material/height buffers, per-level height uniforms, camera
and tile uniforms, the atlas's exact three mip levels, and each resident's full
side-dependent RGBA8 mip chain. Each 128-square LOD tile costs **611684 bytes**:
524288 record bytes, 87380 texture bytes, and 16 uniform bytes. Summary padding is
included. Resident payload allocations are guarded at 256 MiB; driver object
overhead, canvas swapchain images and transient queue staging are not estimated.

Focused verification (native tests require a Metal/Vulkan adapter):

```sh
cargo test -p surface-gpu --locked
cargo clippy -p surface-gpu --all-targets --locked -- -D warnings
cargo clippy -p surface-gpu --target wasm32-unknown-unknown --locked -- -D warnings
cargo build -p surface-gpu --target wasm32-unknown-unknown --locked
```

These cover codec/key/material rejection, packing/accounting, clipped cuts,
negative coordinates and fractional scissor edges, actual summary/fine/legacy GPU
colors, differing tile/height scales, and existing shadow/relief and height-tree
behavior. Browser cut scheduling, cache/root retention and end-to-end viewport
interaction require frontend integration checks.
