# Memory-Bounded LOD

The optional LOD viewer loads independent 128-square surface tiles. Coarse tiles
retain unlit color summaries and height ranges; close-up tiles retain the exact
surface fields. Zooming out releases exact tile buffers and picking records.
Lighting stays interactive, and no rendered map images are downloaded.

The browser supports static prepared maps and explicitly bound live hierarchies
published by `surface-sync`.
Native snapshot preparation and generated live deployments select LOD explicitly.
Public-demo playback retains its separate packet and timeline interfaces.
The declared large-world scale and sustained-performance acceptance require
separate validation; successful small-fixture tests are not those guarantees.

## Prepare and View

Preparation reads an existing derived surface manifest, not a raw world or live
database. It accepts offline v1 and current-state v2 surface manifests and verifies
source hashes before publishing immutable objects and `lod.json`.

The packaged `bedrock-map demo` and `import` commands derive LOD in private staging
before immutable registration. `bedrock-map prepare-lod --state ./map-data
--replace-active` converts an existing selected snapshot into a new registration;
the original stays unchanged. This command's `--max-output-bytes` controls its
2 GiB default conversion budget. The source-level converter below also supports
`--max-output-bytes` and a non-writing `--estimate` mode.

```sh
cargo run --release --locked -p surface-cli -- prepare-lod \
  --map /path/to/manifest.json --output web/public/maps/prepared-lod
npm run wasm
npm run dev
```

Open `http://127.0.0.1:5173/?lod=/maps/prepared-lod/lod.json&players=off`.
For a configured viewer, set `lod_url` relative to the application base path.
An explicitly selected `map` URL retains the non-LOD reader. A prepared map
carrying a live world identity requires a matching viewer binding; preparation
alone does not create a publishing service. Configure `lod_url` to the same-origin
`api/v1/worlds/{world}/terrain/lod.json` route and match `terrain.world_id` and
`terrain.generation` to the dataset. `terrain.url` retains the corresponding
legacy manifest route. `?terrain=off` disables LOD polling for that view.

The synthetic fixture requires no Minecraft assets or private data:

```sh
npm run lod:fixture
npm run wasm
npm run dev
```

Open `http://127.0.0.1:5173/?lod=/maps/lod-fixture/lod.json&players=off`.
Generated objects remain outside Git.

## Native Publication Components

`surface-sync` records changed chunk references in a durable SQLite queue in the
same transaction as the accepted terrain write. Repeated changes coalesce by
chunk; unchanged observations still protect backup reconciliation but do not add
publication work. A frozen queue retains immutable inputs while new edits enter
the next queue. Garbage collection preserves both sets of chunk objects.

The storage-independent node builder produces exact leaves, conservative parent
summaries and height pages from hash-verified, bounded inputs. It preserves all
retained exact fields and rejects missing intersecting children instead of
inventing empty terrain. Repair ordering is separate from the per-chunk backup
fence, so unchanged newer live observations still take precedence over a repair.

The `serve` command runs one background publisher per state directory, protected
by an exclusive process lease. It bootstraps existing chunk references, resumes
unfinished batches after restart, and stages nodes in SQLite. Catalog and source
metadata share the batch's frozen observation boundary. Node decoding and
aggregation happen outside the ingestion mutex; bounded object installation and
metadata transactions use the store's writer lock. Legacy region publication
still runs during ingestion.

`GET` and `HEAD /api/v1/worlds/{world}/terrain/lod.json` return the last complete
hierarchy with ETag revalidation. Until its first publication the endpoint returns 503. The ingest listener does not expose this route. Immutable tile, height,
index and catalog objects are installed and verified before one transaction
exposes their root. Failures retain the previous root; newer observations collect
in the next batch. Garbage collection preserves current and staged references.

The terrain status response includes a separate `lod` object with publication
revision, source revision lag, pending age and the last publication time. Pending
work older than 30 seconds or a publication error reports degraded LOD status.
This does not substitute for the existing gameplay-scan freshness status.

The browser revalidates a bound live root every two seconds while visible, with
one polling cycle in flight and bounded backoff. Each cycle also reads the
same-origin terrain `status` endpoint, including after a 304 root response.
Collection and publication health distinguish starting, live, updating, stale,
degraded and deliberately disabled feeds; failed or invalid reads show delayed.
Diagnostics include publication revision lag and pending age. Status-only changes
and unchanged roots do not redraw terrain. Wrong-world, older-revision and generation-mismatch
responses retain the last valid map. A generation change requires an updated
explicit viewer binding and reopening the map; unrelated generations never blend.

Changed indexes retain displayed detail while replacement metadata loads.
Resident exact tiles compare compact chunk hashes and fetch changed chunks plus
their height page; missing baselines and removed chunk references require a full
tile. Coarse views fetch changed summaries. Surface and height changes share a
GPU submission, and picking updates in the same main-thread turn. Camera,
lighting and independent player state remain intact. Compatible catalog appends
preserve existing IDs; changed descriptors or atlases trigger a coarse-first
reconstruction without retaining incompatible terrain resources.

The root revision in diagnostics is the adopted publication, not a claim that
every resident tile has finished updating. Detail failures retain last-known
coverage and retry. The local preview proxy and generated gateway expose only the
explicit LOD GET/HEAD read route, preserving world and method restrictions.
`deploy prepare` derives static LOD and finishes the seed's first live publication
before sealing inventories. Generated live bindings use that publication rather
than the offline hierarchy. The legacy live manifest remains available. Public
demo playback and release-wide acceptance are separate integration requirements.

```sh
cargo test --locked -p surface-sync
node scripts/terrain-fixture.mjs --small-only
npx playwright test tests/lod-live.spec.ts
```

## Memory and Scheduling

The LOD path charges at most **200,000,000 bytes** of application-managed memory.
Set `memory_budget_bytes` to `128000000` in viewer configuration for the
constrained-budget test. Raising this setting above the ceiling is rejected.

- Committed main/decoder WASM pages and their remaining growth allowances are
  reported separately. Each instance has a 16 MiB allowance.
- CPU picking and bounded metadata, transport reservations, GPU buffers/textures,
  canvas backing estimates and resources awaiting retirement stay charged.
- Material descriptors are fetched in pages needed by resident exact tiles and
  released when those tiles are evicted. A worker-generated dependency bitset
  avoids scanning surface columns on the UI thread.
- An 18 MB loading/retirement allowance and 8,445,568 bytes of ancillary headroom
  are unavailable for ordinary cache filling.
- Height pages use a fixed GPU arena with no CPU world-height pyramid. Empty
  slots remain charged as allocated capacity.
- Shadow coverage includes each rendered or refining tile's full shaded area and
  its gutter, plus pinned roots. Intermediate levels needed only for metadata do
  not retain height pages. A finer cut waits for its required pages and mixed-edge
  parent/gutter sources, including sources outside the visible area.
- Upload reservations survive native queuing. Retired GPU resources remain
  charged until asynchronous queue completion, without blocking navigation.
- Coarse coverage remains available while detail loads. Refinement is debounced;
  a 200 ms transition keeps both cuts resident until completion. Reduced motion
  uses atomic replacement. Each cut's edge lighting is evaluated separately;
  fading weights apply to the complete contributions, not their topology.
- Available sibling groups refine independently. Adjacent tiles, including
  corner neighbors, differ by at most one level. Failed detail keeps its
  covering parent without preventing healthy neighboring groups from refining.
- Mixed-resolution edges blend through resident parent caches. Camera movement
  within the same tile footprint reuses the selected cut rather than rebuilding
  it every frame. Active and fading cuts retain their parent caches until those
  edges are no longer displayed. Their required height pages remain resident
  through the fade, then become eligible for eviction.
- Navigation retains bounded ancestor metadata independently of surface data.
  Ready detail remains selectable through evicted intermediate surface levels;
  only pinned roots, displayed/fading tiles, pending refinement and actual edge
  dependencies retain surface buffers. Missing sibling coverage falls back to
  a ready ancestor while unrelated branches remain eligible for refinement.
- A terminal sparse summary can supply finer mixed-edge gutters only when the
  shared decoder verifies that every source sample lacks present terrain.
  Projection retains unknown/empty/outside flags and conservative mixed coverage;
  missing or corrupt objects never become absence certificates.

This ledger is not browser RSS. Browser networking, JavaScript engine overhead,
compositor swapchains and driver allocations require separate process-level
measurement. Inspection follows the displayed cut, not finer cached records.
Coarse inspection reports approximate heights and ranges, not an exact material.

`window.__map.state().lod.gpuProgress` reports submitted and callback-acknowledged
queue serials and the monotonic age of the oldest outstanding submission. Ages
marked `ageExact: false` are conservative upper bounds from bounded timestamp
coalescing. These diagnostics distinguish advancing from unchanged acknowledgments;
they do not independently measure GPU execution time or diagnose a driver stall.
Download failures retain available coverage and retry with
bounded backoff. Hidden documents suspend new loading and resume when visible.
Device loss cancels pending work and triggers one coarse-first reconstruction,
preserving the camera, lighting and independent player layer. A second loss or a
failed reconstruction requires an explicit Retry.

## Verification

```sh
npm run lod:test
npm run lod:sparse-fixture
cargo test --locked -p surface-core -p surface-cli lod
cargo test --locked -p surface-gpu
npx playwright test tests/lod.spec.ts tests/lod-failure.spec.ts tests/lod-residency.spec.ts tests/lod-sparse.spec.ts
```

Native GPU tests require a wgpu adapter. Synthetic browser tests check rendering,
retirement, constrained admission, malformed responses and navigation recovery.
Their results do not establish reference-device performance.
The sparse browser fixture contains four populated regions in a 2,048-square
extent, with terminal unknown areas between them; it is not the 4,096-region
sparse scale workload.

With the synthetic viewer already running on loopback port 5195:

```sh
node scripts/check-lod.mjs --workload-hz 60 --seconds 120
node scripts/check-lod.mjs --seconds 120 --video
node scripts/check-lod-safari.mjs \
  --url 'http://127.0.0.1:5195/?lod=/maps/lod-fixture/lod.json&players=off'
```

The Safari command requires an already enabled local WebDriver and a visible
Safari window. No script changes browser security or physical display settings.
The Chrome harness records actual rAF cadence separately from its pan-input cap;
video and screenshots may affect timing. Reports, screenshots and recordings
stay under `.local/`. Physical iPad acceptance is separate from desktop layouts.

For generated scale fixtures, run the correctness and residency harness with an
explicit loopback URL and browser mode:

```sh
node scripts/check-lod-scale.mjs --mode headful \
  --url 'http://127.0.0.1:5195/?lod=/maps/prepared-lod/lod.json&players=off'
```

The harness checks coarse-first loading, Fit World, far-corner navigation,
revisiting detail, idle rendering and managed memory. `--seconds 1200` requests
a 20-minute minimum navigation window. `--budget 128000000` verifies an already
configured constrained viewer; it does not change configuration. Optional
`--simulate-objects` delays buffered responses using a shared 20 Mbps delivery
budget plus 50 ms per object. This is not a physical-network or FPS measurement.
PNG nonblank checks require visual inspection, and a declared dataset extent
does not prove its populated-region count.
Keep served source and assets unchanged during a run. Document navigation or
viewer-counter resets invalidate the recording; the report retains the recent
phase/camera observations and the highest charged memory even on failure.

See the [core format contract](../crates/surface-core/LOD.md) and
[GPU ownership and API contract](../crates/surface-gpu/LOD.md).
