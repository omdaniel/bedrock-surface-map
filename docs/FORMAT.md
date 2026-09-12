# Format and Rendering

## SurfaceRegion v1

A region is 256 by 256 block columns, row-major `z * 256 + x`. Region coordinates
use Euclidean division: block (-1,-1) belongs to region (-1,-1), local (255,255).
World x/z are implicit. Coverage is 0 (unknown/not retained) or 1 (present), never
inferred from a material ID or height. Missing height sentinel is signed -32768.

Binary body: `BSM1`, signed little-endian i32 region x/z, then independent
channels in this order:

1. coverage (u32)
2. material/state ID (u32)
3. packed RGB biome tint input (u32)
4. source biome ID (u32; unknown = 0xffffffff)
5. optional thin-overlay material ID (u32; none = 0)
6. water depth (u32, parser-reported capped depth)
7. supporting-surface material ID (u32)
8. top height (i16, sixteenths of a block)
9. overlay top height (i16)
10. supporting-surface top height (i16)

Each channel has a u8 mode, u8 bit width and little-endian u32 base/count.
Mode 0 stores minimum plus bit-packed offsets; width zero represents a constant.
Mode 1 stores a local sorted u32 palette followed by bit-packed palette indices.
Packing is least-significant-bit first. Heights are biased by +32768 before
channel encoding. The encoder chooses palette mode only when smaller. The body
is Zstd level 3 compressed, SHA-256 addressed, and exactly round-trip verified.

The shared native/WASM decoder validates signatures, mode/width, palette indices,
channel sizes, heights, coverage and trailing data. It preflights Zstd content
and window sizes before allocation, bounds output, verifies a frame checksum
when present, and rejects additional frames. Each network object also has a
manifest SHA-256 checked by the Web Worker before decoding.

Material IDs refer to a manifest catalog with the full namespaced block name
and serialized block states, selected top texture, tint class, atlas UVs,
average color and approximation marker. Repeated imports of the same snapshot
are deterministic. A changed catalog requires its matching manifest; cached
regions from another manifest are not mixed into a session.

The manifest contains format version, bounds (exclusive max x/z), spawn,
source hash, catalog hash, atlas URL, content-hashed region references and the
compressed complete i16 heightfield. All objects precede atomic manifest
replacement. Source spawn is retained; private player positions are not.

## GPU Pipeline

The worker decodes transport arrays into 32-byte resident column records.
The main thread retains only 8-byte picking records; material metadata is shared.
GPU drawing uses one quad per region, with height/material storage lookups.
There is no scene object, border mesh or draw call per block.

Mojang textures become a shared atlas of 32-pixel tiles with four-pixel duplicated
edge padding. Two atlas mip levels preserve padding. Nearest magnification,
linear minification, and blending toward material averages prevent undersampled
textures from flickering. Transparent canopy texels receive a shaded material
base: this is an opaque canopy approximation, not multilayer transparency.
Water blends a retained support surface with water color according to depth;
thin vegetation alpha-blends over its supporting top surface. Snow layers and
slabs preserve fractional top height. No model geometry is reconstructed.

The orthographic north-up camera uses a fixed parallel light from northwest,
60 degrees above the horizon. For each NW-to-SE diagonal the compute shader
maintains `horizon = max(height, horizon - sqrt(2)*tan(60 degrees))`. A column is
shadowed when the propagated horizon exceeds its top. Complexity is linear in
the dataset's bounding rectangle, not per-pixel multi-step ray marching.

The theoretical horizontal reach of a height difference H is `H / tan(60)`;
10 blocks gives 5.7735 blocks. The grid samples this at diagonal cell centers:
four diagonal steps are shadowed, five are not. Shadow fixtures cover flat
ground, a column, terraces and a boundary with a missing sample. The complete
heightfield supplies all known up-sun occluders, even for nonresident regions.
Changing snapshots rebuilds the shadow buffer and all dependent overview levels.

Overview compute writes an RGBA texture from surface colors, overlays, water and
cached shadows. Subsequent GPU compute passes box-filter premultiplied levels.
The viewer selects/blends overview levels below one pixel per block. No overview
images are exported. Region-edge filtering is local to each region, not a global
texture; very coarse transitions are an acknowledged prototype approximation.

Block borders use fragment derivatives and procedural fractional coordinates,
fade with zoom, and require no per-block geometry. Elevation contours are not
drawn. Shadows are cached, not recomputed for camera motion. Grid toggles only
redraw; shadow toggles regenerate resident overview colors. LRU eviction prefers
nonvisible regions and destroys their GPU resources; loading stays two requests
at a time. An unchanged view schedules no animation loop.
