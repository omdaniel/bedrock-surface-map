# Format and Rendering

## Region and Chunk Formats

A `SurfaceRegion` contains 256x256 columns in row-major `z * 256 + x` order.
Coordinates use Euclidean division: block (-1,-1) belongs to region (-1,-1),
local (255,255). X/Z positions are implicit. Missing height is signed -32768.

The region body begins with `BSM1` or `BSM2`, followed by signed little-endian
i32 region X/Z and independent channels in this order:

1. Coverage (u32)
2. Material/state ID (u32)
3. Packed RGB biome tint (u32)
4. Source biome ID (u32; unknown = 0xffffffff)
5. Thin-overlay material ID (u32; none = 0)
6. Water depth (u32)
7. Supporting-surface material ID (u32)
8. Top height (i16, sixteenths of a block)
9. Overlay top height (i16)
10. Supporting-surface top height (i16)

BSM1 accepts coverage 0 (unavailable) or 1 (present). BSM2 also accepts 2
(verified empty). Coverage is explicit, never inferred from material or height.

Each channel stores a u8 mode, u8 bit width and little-endian u32 base/count.
Mode 0 uses a minimum plus bit-packed offsets; width zero is constant.
Mode 1 uses a sorted local u32 palette and bit-packed indices, selected only
when smaller. Packing is least-significant-bit first. Region heights are biased
by +32768 before encoding.

A `SurfaceChunk` contains 16x16 columns. Its `BSC1` header carries signed
little-endian i32 chunk X/Z. Its ten channels use a different order:
coverage, top height, material, tint, biome, overlay material, overlay height,
water depth, support material, support height. All are represented as i32,
biased by 2^31 for the shared unsigned channel encoder.
[The codec types](../crates/surface-core/src/terrain.rs) define validation and
chunk-to-region mapping.

Published objects use Zstandard compression and SHA-256 addressing.
Compression reconstructs retained fields exactly, not the underground world.
The native/WASM decoder validates signatures, modes, widths, palette indices,
sizes, heights, coverage and trailing data. It bounds decompression and window
allocation, verifies Zstd checksums when present and rejects extra frames.
The Web Worker verifies each downloaded object's manifest hash before decoding.

## Manifests and Catalogs

Offline manifests contain bounds (exclusive max X/Z), spawn, source fingerprint,
material catalog, atlas and hashed region references, plus a complete compressed
heightfield. Import writes objects before atomically replacing the manifest.
An offline viewer pins that manifest/catalog for the session; reload to adopt
another import. World spawn is retained, not private player records.

Live manifests use format version 2 with explicit `world_id`, `generation`,
revision, bounds, height range and catalog/atlas references. The root references
regional indexes, complete region objects and height-only objects. Each index
references its current chunks. Cold loads use regions; connected viewers compare
hashes and fetch changed chunks. A missing index or incompatible chunk coverage
falls back to a complete region replacement, not a historical patch log.

Material descriptors include block/state identity, top texture, tint class,
atlas UVs, average color and approximation status. Live IDs append within a
generation; classification uses shared versioned rules. The texture library has
stable placement independent of encountered block states. Catalog updates load
before dependent terrain; an atlas or dataset-generation change requires reload.
See [terrain synchronization](TERRAIN-SYNC.md) for ordering and publication.

## Surface Rendering

The worker converts decoded columns into 32-byte GPU records; the main thread
retains 8-byte picking records. Drawing uses a quad per region with storage-buffer
lookups, not an object or draw call per block.

The local Mojang atlas uses 32-pixel tiles with four-pixel duplicated edge padding
and two mip levels. Nearest magnification, linear minification and blending
toward material averages limit undersampling flicker. The public demo supplies
its own original texture atlas through the same rendering interface.

Canopy transparency is an opaque top-surface approximation. Water blends the
retained support with depth-dependent color; thin vegetation blends over its
support. Slabs and snow preserve fractional height. Complex model geometry and
multilayer waterlogged surfaces are not reconstructed.

Sunlight is parallel, with 330-degree azimuth and 45-degree elevation defaults.
Azimuth is clockwise from north; `sun_direction` computes
`(sin(azimuth), -cos(azimuth))` in X/Z after conversion to radians.
Diagnostics identify `azimuthConvention: "north-clockwise"`. Lighting is session
state, not part of the surface format. [Appearance](APPEARANCE.md) describes
Vivid/Original color, shadows, sand grading and terrain-edge relief.

A max-height pyramid accelerates sunward ray queries. Its buffer contains 32
vec4<u32> descriptors followed by f32 height levels; descriptor 31.w holds the
level count. Each parent is the maximum of its existing 2x2 children, including
odd edges. Missing cells use -1e6 and do not occlude. Four stratified footprint
samples provide fractional-block shadow coverage.

Overview compute shades region colors, overlays, water and shadows, then
box-filters premultiplied mip levels. The viewer blends levels below one pixel
per block. Filtering is local to each region; no overview images are exported.
Procedural borders use fragment derivatives and fade with zoom. Relief uses
neighbor heights and analytical band coverage, without contour or edge meshes.

## Height Coverage and Caching

Offline maps carry a complete dataset heightfield. Live maps and the demo use
region-aligned working windows around the visible area, including offscreen
height-only pages. The margin derives from the dataset's height range and sun
elevation: `height_difference / tan(elevation)`, plus neighbor padding. Unknown
terrain outside mapped coverage cannot supply an occluder.

Changing the window rebuilds its CPU/GPU height pyramid. A live height update
patches a region's height rectangle and affected ancestors. It invalidates
resident shaded overviews; a material-only chunk update invalidates its region's
overview. Dirty overviews regenerate before drawing. GPU column patches and
CPU picking records update together without resetting camera, lighting or players.

Lighting changes invalidate overview colors. Height samples remain valid, but
lowering sun elevation can require a larger live height window and a rebuilt
pyramid for the longer shadow reach. Camera movement reuses valid overviews and
the height window while covered, but close-up fragments perform ray queries on
each draw. Unchanged polls and player-only motion do not request terrain frames;
following a player moves the camera and therefore redraws terrain.

The logical map budget is 256 MiB, including resident detail, picking records,
CPU/GPU height trees and compact live height pages. Eviction prefers nonvisible
detail. Camera and lighting changes reserve space for both visible detail and
required shadow coverage before loading. A view that cannot fit is refused with
a zoom-in notice; the last supported camera and sun elevation remain usable, and
the elevation control reflects the retained value. Enlarging the browser
window tightens the zoom when necessary. Shadows are not silently clipped. This
budget is not total browser/driver RSS or a bound on transient allocations. Region
loading uses two requests at a time; an unchanged view has no continuous terrain loop.
