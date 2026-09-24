# Native LOD v1

`surface_core::lod` exports `TileKey`, `DetailTile`, `SummaryTile`, `HeightTile`,
`LodManifest`, `LodNode`, and their reference types. Tile codecs expose
`encode(&self) -> anyhow::Result<Vec<u8>>`, `decode(&[u8]) -> anyhow::Result<Self>`,
`validate(&self) -> anyhow::Result<()>`, and `gpu_words(&self) -> Vec<u32>`.
Use `decompress_lod(&compressed_bytes)` before decoding a transported tile.
Manually constructed tiles require validation before GPU upload.

## Coordinates and Coverage

Each tile has 128 by 128 row-major samples. A key is `{level:u8,x:i32,z:i32}`;
its world span is `128 << level` and its origin is `(x*span,z*span)`.
Levels are 0 through 16, and tile extents must fit in [-8388608,8388608].
Bounds are `[min_x,min_z,exclusive_max_x,exclusive_max_z]`. Parents use Euclidean
floor division, including negative coordinates. Children are NW, NE, SW, SE.
`root_keys` chooses the smallest common level with at most one root per sign
quadrant. A positive 1024-square map has one L3 root; a centered 1024-square map
has four L2 roots.

Detail columns preserve all ten `terrain::Column` fields:
`[coverage,height,material,tint,biome,overlay,overlay_height,water_depth,support,support_height]`.
Heights are signed sixteenths of a block. Biome values preserve their source u32
bit patterns through the signed column representation. Coverage is 0 unknown,
1 present, 2 verified empty, or 3 outside map bounds. Present samples require a
material and a non-sentinel height. Other exact fields remain lossless, including
fields which are not currently uploaded to the GPU.

Summary and height flags are present=1, empty=2, unknown=4, outside=8, water=16.
Water implies present. Absent heights use `i16::MIN`. Parent flags are bitwise OR;
only present samples contribute to min/max heights, even when their quantized
fraction rounds to zero. Means and colors use quantized present fractions with
a minimum weight of one for a surviving present flag. Fractions and means are
approximate; extrema and coverage presence remain conservative through level 16.
Coarse nodes without children represent terminal unknown regions. Missing child
references denote quadrants wholly outside bounds, not verified-empty terrain.

## Binary Layout

All integers are little-endian. Each raw page begins with a 16-byte header:
four-byte magic (`BSD1` detail, `BSS1` summary, `BSH1` height), u8 level, three
zero reserved bytes, signed i32 x, signed i32 z. The magic suffix is the version.
Truncated, oversized, trailing, out-of-range and inconsistent data is rejected.
`BSM1`, `BSM2`, and `BSC1` are unchanged.

Detail encodes ten channels in column order. Each signed field is biased using
`(value as u32) ^ 0x80000000`, then encoded with the existing constant,
frame-of-reference or palette bit-packing. The same decoder preserves all bits.
The GPU output is eight words per cell, in the existing renderer order:
`[signed_height,material,tint,overlay,water_depth,support,signed_overlay_height,coverage]`.
Signed heights are sign-extended to u32 words.

Summary payloads are exactly 24 bytes per sample, also their six GPU u32 words:

| Word | Low bits | High bits |
| --- | --- | --- |
| 0 | original R u16 | original G u16 |
| 1 | original B u16 | vivid R u16 |
| 2 | vivid G u16 | vivid B u16 |
| 3 | mean height i16 | min height i16 |
| 4 | max height i16 | present fraction u8, empty fraction u8 |
| 5 | unknown fraction u8, water fraction u8 | flags u16 |

Colors are UNORM16 averages in the existing renderer's numeric working space.
`appearance_colors` applies the unlit overview WGSL tint, support/water,
alpha, overlay and grading equations for original and vivid palettes. It does
not apply lighting or an additional sRGB transfer. Appearance version is `"1"`.
`SummaryTile::from_detail` makes an L0 intermediate for native reduction; only
coarse summaries can be encoded. `from_children` validates four ordered child keys.

L0 height pages use one word per sample: height i16 low, flags u16 high. Coarse
height pages use two: mean i16 low and flags u16 high, then min i16 low and max
i16 high. The raw payload is identical to the GPU words after the header.

Each tile is transported in one Zstd frame, with at most 2 MiB compressed bytes,
2 MiB decoded bytes, and a 2 MiB decoder window. `decompress_lod` checks the frame
header before constructing ruzstd, and rejects checksum mismatches and trailing
frames. The legacy decompression API retains its existing 64 MiB window bound.

## JSON and Publication

All new immutable files use `objects/{sha256}.zst`, `.json`, or `.png`. SHA-256
covers the exact stored bytes, including compression. Every URL in every object
resolves against `lod.json`, never against an index's nested directory.

```text
ObjectRef = {url, sha256, bytes}
NodeRef = {key: TileKey, index: ObjectRef}
LodNode = {key, data: ObjectRef, height: ObjectRef, children: NodeRef[],
           chunks?: [{cx,cz,...ObjectRef}]}
LodManifest = {format_version:1, kind:"surface-lod", name, bounds, spawn,
               source_sha256, generation, world_id?, revision,
               appearance_version:"1", height_range, atlas:ObjectRef,
               catalog:[{start,count,...ObjectRef}], material_count, roots:NodeRef[]}
```

Catalog payloads are bare arrays of the existing `Material` shape, with at most
256 entries and 64 KiB of encoded JSON per page. Catalog ranges are contiguous.
Node indexes and the top descriptor also have a 64 KiB byte limit. Atlas PNGs
have a 32 MiB stored byte limit. There are at most 256 catalog pages and 65536
materials. Catalogs requiring more pages, entries larger than one page, or a
descriptor exceeding 64 KiB are explicitly rejected; v1 has no structural
catalog paging. Names have at most 256 UTF-16 units, optional world IDs
80, generations 128, and source fingerprints 64 lowercase hex digits.
Material keys have at most 4096 UTF-16 units; names and texture strings have
1024. Empty texture strings are accepted for existing unknown material entries.
Revisions must fit a JavaScript safe integer. Nodes have at most four children;
detail leaves can retain up to 64 verified existing BSC chunk references.

The CLI writes and verifies immutable objects before atomically publishing
`lod.json`. An unsuccessful conversion may leave unreachable immutable objects;
it does not replace an existing descriptor. This is an offline writer, not a
concurrent publisher or a production deployment command.

## CLI and Verification

```sh
cargo run --locked -p surface-cli -- prepare-lod --map /path/manifest.json --output /tmp/lod
cargo run --locked -p surface-cli -- lod-fixture --output /tmp/lod-fixture
cargo test --locked -p surface-core -p surface-cli lod
```

`prepare-lod` accepts local v1 offline and v2 surface manifests, verifies source
object hashes, leaves source manifests and files intact, and never reads their
whole-world height object. Terrain memory is bounded by one cached 256-square
region and at most four summary pages per level; source region metadata and the
material catalog scale separately with the manifest. Absent source subtrees are
emitted directly as terminal coarse pages without expanding their detail tiles.
Source JSON and legacy catalogs are individually capped at 64 MiB. Input URLs
must be local paths that remain within the source manifest's directory.

The atlas is copied as an ordinary hashed PNG file. V2 source world/generation/
revision fields are retained. V1 generation defaults to `offline-{manifest_sha256}`.
A legacy non-hash source label defaults to the manifest SHA-256 as the new
descriptor fingerprint; its original label remains in the retained source file.

`lod-fixture` generates a centered 1024-square coastline with high relief,
negative coordinates/heights, water/support, biome tint, overlays, foliage,
unknown and verified-empty patches. Its tree contains 64 exact L0 leaves, 16 L1
nodes and four L2 roots. A region-only source manifest remains under
`source/manifest.json`. Terrain and custom textures are synthetic; no worlds,
private data, downloaded Minecraft assets or global height arrays are used.

The `lod-fixture` stdout JSON includes `diagnostics` (schema version 1): conversion
and total elapsed milliseconds, source region/material counts, root/node/detail/
summary/height/catalog counts, counts and data/height bytes per level, and a
`referenced_bytes` breakdown with a total. Byte totals include `lod.json` and its
reachable object references; they exclude retained source files and unreachable
objects from earlier runs. Diagnostics walk small node indexes depth-first and
never decompress tile payloads. Timings are not written into the dataset, so they
do not affect its content hashes. The native fixture API with diagnostics is
`surface_cli::lod::create_lod_fixture_with_diagnostics`.

For an identical-data legacy-renderer reference (including baseline `57c66a`):

```sh
cargo run --locked -p surface-cli -- lod-fixture --output /tmp/lod-fixture --legacy-reference
```

Load `/tmp/lod-fixture/source/manifest.json` through the baseline viewer's local
map URL, and `/tmp/lod-fixture/lod.json` through the candidate LOD viewer. The flag
adds a hashed Zstd file of 1024 by 1024 row-major little-endian i16 heights to the
source manifest. It uses the same generated columns, bounds, spawn, material
catalog and atlas as the LOD tree. Unknown and verified-empty samples both use
the legacy missing-height sentinel `-32768`. The extra raw height buffer is
fixed at 2 MiB and exists only inside this synthetic fixture generator.
`prepare-lod` has no such option and still never reads or allocates a global
height field. Without the flag, source height references remain empty.

Diagnostics include a `legacy_reference` object with the source manifest path,
dimensions, compressed/decoded height bytes and SHA-256. This auxiliary source
file is excluded from the LOD `referenced_bytes` total. Adding height references
changes the source manifest hash and derived offline generation, but not the
terrain, atlas, or LOD node/data objects. The library entry point is
`create_lod_fixture_with_options(output, LodFixtureOptions { legacy_reference: true })`.
