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

The orthographic north-up camera uses parallel sunlight. Elevation defaults to
45 degrees (range 15-75); azimuth defaults to 135 degrees (range 0-360 in 1-degree
steps). The direction towards the sun in X/Z is `(cos(azimuth), -sin(azimuth))`:
east=0/360, north=90, west=180, south=270. Cardinal components are snapped to exact
zero to avoid drift; intermediate angles use their actual direction, not blends
between presets.

A direction-independent max-height pyramid replaces the northwest-only horizon
sweep. Rust/WASM builds it once from the complete decoded heightfield. Its GPU
storage contains 32 vec4<u32> level descriptors followed by f32 heights. A level
descriptor holds data offset, width and height; descriptor 31.w is the level count.
Each level stores the maximum of its existing 2x2 children, including odd edges.
Missing cells have height -1e6 and never invent an occluder. This is a resident
acceleration structure, not a change to the published surface format.

The shared shadow shader follows rays towards the sun, skipping a hierarchy node
only when its maximum is below the ray on entry. Leaves test actual block
intersections. Four stratified subpixel samples anti-alias partial-block shadows;
overviews sample the entire block before GPU mip filtering. This is sampled
coverage, no longer the earlier northwest-only analytical area integration.
See [APPEARANCE.md](APPEARANCE.md) for the tradeoff and independent ray-walk tests.

The theoretical horizontal reach of a height difference H is `H / tan(elevation)`;
10 blocks gives 5.7735 blocks at 60 degrees, or 10 blocks at 45 degrees. The
complete heightfield supplies all known up-sun occluders, even for nonresident
regions. Changing either sun angle regenerates resident overview colors. Camera
motion reuses the hierarchy and overview levels, but close-up fragments perform
ray queries. The hierarchy is rebuilt only when loading a snapshot.

Vivid color treatment normalizes grayscale grass/leaf texture brightness before
applying the approximate biome palette, then adds mild saturation and brightness.
It also uses a richer blue water base. Original preserves the earlier color
formulas, but uses the corrected shadow model. Both detail and overview passes
share the same WGSL appearance functions. Shadow strength and color treatment
only regenerate resident overview colors, not the height hierarchy.

Overview compute writes an RGBA texture from surface colors, overlays, water and
shadow samples. Subsequent GPU compute passes box-filter premultiplied levels.
The viewer selects/blends overview levels below one pixel per block. No overview
images are exported. Region-edge filtering is local to each region, not a global
texture; very coarse transitions are an acknowledged prototype approximation.

Block borders use fragment derivatives and procedural fractional coordinates,
fade with zoom, and require no per-block geometry. Elevation contours are not
drawn. Overview lighting is cached. Grid toggles only
redraw; shadow toggles regenerate resident overview colors. The resident budget
includes the complete height hierarchy. LRU eviction prefers
nonvisible regions and destroys their GPU resources; loading stays two requests
at a time. An unchanged view schedules no animation loop.
