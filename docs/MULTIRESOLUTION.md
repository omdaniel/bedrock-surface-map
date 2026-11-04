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

Select the hierarchy in the viewer's `viewer-config.json`:

```json
{
  "lod_url": "maps/world/lod.json",
  "object_cache": { "enabled": true, "maxBytes": 268435456 }
}
```

Paths are relative to the application's base path, including subpath hosting.
For local inspection, `?lod=/maps/world/lod.json&players=off` selects an explicit
same-origin hierarchy. Player tracking requires its own matching world binding.

The packaged application also supports explicit preparation and registration:

```sh
bedrock-map prepare-lod --input /path/to/surface
```

It verifies an existing hierarchy or converts the supplied surface snapshot,
then selects an immutable dataset. Ordinary import and demo commands do not
silently perform this conversion. A standalone hierarchy supports read-only
viewing; live seeding also requires the surface snapshot.

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

Generated deployments opt in with `features.terrain_lod = true`, alongside
terrain synchronization. Local preview proxies use `SURFACE_TERRAIN_LOD=true`;
the HTTPS LAN helper accepts `--terrain-lod`. These settings select the same
read-only descriptor route, without exposing ingestion.

## Browser loading and storage

The browser requests immutable files with ordinary HTTP GETs. Camera movement
does not create server-side sessions, subscriptions or synchronization state.
The server remains the authority for terrain; browser caches are disposable.

Visible work takes priority over a surrounding half-screen guard band and
bounded directional lookahead. At most two loading jobs run concurrently.
Prepared coarse roots stay resident while more detailed tiles load. Nearby
panning uses prepared detail where available; a large jump or fast movement
beyond the buffer can temporarily show coarse coverage. Missing downloads are
reported and retried, not interpreted as empty terrain.

IndexedDB stores hash-verified objects from different levels, bounded by both
bytes and entry count. The default disk allowance is 256 MiB and 2,048 entries.
It is separate from map memory. Browsers may deny or evict storage; write
backpressure can skip a cache entry. The viewer then uses the network. This is
a reusable local cache, not an offline-download guarantee. Disable or resize it
through `object_cache`; clearing this site's browser storage removes its cache.

The client adapts resolution to physical sample size and the bounded guard
window, without moving the camera. It holds up to 160 surface tiles and 256
height-page entries, with nonvisible detail evicted first. Each tile has 128²
samples regardless of its world span. Height allocation covers the buffered
view and its sun-facing shadow margin rather than the world's bounding box.
Small pans reuse a prepared height window while the full lighting footprint fits.

The application map allowance is 256 MiB, including a 64 MiB working reservation:
32 MiB for committed main/decoder WASM capacity and 32 MiB for bounded decode,
upload and height-replacement work. WASM capacity above its allowance is charged
additionally. Diagnostics distinguish resident bytes, reserve, WASM capacity and
high-water use. This is not a browser RSS limit: JavaScript engine overhead,
canvas presentation, driver allocations and browser-managed storage/networking
are separate. Disk cache size does not imply equivalent RAM residency.

Fine surfaces use the shared texture, water, overlay and relief renderer.
Coarse surfaces retain interactive sunlight but use approximate color and height
summaries; inspection labels their scale and elevation range. Player projection
shares the camera and does not redraw terrain unless following moves the camera.
Unchanged polls do not draw. Hidden tabs suspend loading and publication polling.
Generation or incompatible appearance changes require an explicit reload, so
old and new dataset identities cannot be blended accidentally.

## Verification

```sh
cargo test --locked -p surface-core -p surface-cli -p surface-sync
npm run lod:test
./dev test -- tests/lod-viewer.spec.ts tests/lod-source.spec.ts tests/object-cache.spec.ts
```

Synthetic tests cover signed coordinates and sparse bounds, exact leaf fields,
summary/height contracts, corruption and decompression bounds, deterministic
conversion, changed-source rejection, quota preservation, live unchanged writes,
incremental ancestors, continuous writes, resumable batches, garbage collection,
and the read-only HTTP routes. These checks establish data/publication behavior;
browser checks exercise real encoded coarse/detail rendering, buffered movement
during network failure, persistent-cache reuse, zoom reversals and idle redraw
behavior. Hardware performance remains a separate measurement.
