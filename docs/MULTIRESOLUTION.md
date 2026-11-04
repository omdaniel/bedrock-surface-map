# Multiresolution surface data

The surface hierarchy contains independently downloadable exact detail, unlit
coarse summaries, height pages and spatial indexes. Each tile contains 128 × 128
samples. Level zero represents individual blocks; level L spans `128 × 2^L`
blocks on each axis. Four children contribute to one parent. Tile coordinates
use floor division, including at negative world coordinates.

## Prepare a snapshot

An existing version-one offline or version-two live surface snapshot is the
input. No raw world, live LevelDB or Minecraft account is required.

```sh
cargo run --release --locked -p surface-cli -- prepare-lod \
  --map /path/to/surface/manifest.json \
  --output /path/to/site/maps/world \
  --max-output-bytes 2147483648
```

Add `--estimate` to inspect the source and report a conservative format ceiling
without generating files. The estimate is not a prediction of compressed size.
The completed command reports actual referenced bytes and elapsed time as JSON.
The configured quota includes reused objects. A failed conversion preserves an
existing published descriptor; unreferenced objects may remain after failure.

Serve the output directory with an ordinary static HTTP server. `lod.json` is
published after its immutable dependencies. It references at most four root
indexes, catalog pages and the shared texture atlas. Indexes reference their
own surface/height objects and up to four child indexes. Browsers can traverse
only the requested branches; the root does not enumerate every region.

The converter verifies source object lengths/hashes and rechecks the source
publication before replacing `lod.json`. Its terrain buffers contain one source
region and a bounded number of summary pages per hierarchy level.

## Data and appearance

Level-zero detail preserves all retained surface fields exactly. Coarse samples
are lossy summaries: original/vivid unlit colors, mean/minimum/maximum elevation,
coverage fractions and water/coverage flags. Colors use the renderer's existing
numeric texture space and include its tint, water, overlay and sand treatment.
Sunlight remains a client rendering choice; no shaded map-image tiles are
exported.

The 24-byte summary record uses explicit integer packing. Compressed objects
have a 2 MiB transport/output/window limit. Node and catalog pages have a 64 KiB
limit. The shared Rust decoder validates coordinates, ancestry, coverage,
extrema and object shapes before accepting data. Missing data and verified empty
columns remain distinct. Coverage flags retain the existence of tiny features
even when quantized fractions round down.

## Live publication

`surface-sync serve --lod` enables the optional publisher; `TERRAIN_LOD=true`
provides the equivalent environment setting. Existing ingest and manifest
interfaces retain their authentication and behavior.

The read listener exposes:

```text
GET /api/v1/worlds/{world}/terrain/lod.json
GET /api/v1/worlds/{world}/terrain/objects/{content-hash}.{extension}
```

The descriptor supports ETag revalidation and HEAD. Public gateways must
explicitly allow the read route; the ingest listener is separate.

Accepted changed chunks enter a durable coalescing queue. The publisher freezes
a batch, builds its changed leaves and ancestors outside the ingestion lock,
installs immutable objects, and publishes a coherent root. Later observations
remain queued for the next batch. Unchanged observations do not rebuild terrain.
Restarted publishers resume their frozen batch. Garbage collection protects
current and pending hierarchy references, and quota failure retains the last
valid publication. Catalog appearance changes can require broader rebuilding.

Health information includes publication revision lag, pending age and publisher
errors. Turning off the publisher preserves its last publication and reports its
paused state; it does not alter gameplay or remove the existing surface feed.

## Verification

```sh
cargo test --locked -p surface-core -p surface-cli -p surface-sync
```

Synthetic tests cover signed coordinates and sparse bounds, exact leaf fields,
summary/height contracts, corruption and decompression bounds, deterministic
conversion, changed-source rejection, quota preservation, live unchanged writes,
incremental ancestors, continuous writes, resumable batches, garbage collection,
and the read-only HTTP routes. These checks establish data/publication behavior;
browser navigation and hardware performance require separate measurements.
