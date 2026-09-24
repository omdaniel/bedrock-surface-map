# Memory-Bounded LOD

The optional LOD viewer loads independent 128-square surface tiles. Coarse tiles
retain unlit color summaries and height ranges; close-up tiles retain the exact
surface fields. Zooming out releases exact tile buffers and picking records.
Lighting stays interactive, and no rendered map images are downloaded.

This interface currently supports static prepared maps. Live hierarchy
publication, the packaged deployment workflow and public-demo playback do not
consume it. Existing offline and live viewers retain their existing interfaces.
The declared large-world scale and sustained-performance acceptance require
separate validation; successful small-fixture tests are not those guarantees.

## Prepare and View

Preparation reads an existing derived surface manifest, not a raw world or live
database. It accepts offline v1 and current-state v2 surface manifests and verifies
source hashes before publishing immutable objects and `lod.json`.

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
alone does not enable live updates.

The synthetic fixture requires no Minecraft assets or private data:

```sh
npm run lod:fixture
npm run wasm
npm run dev
```

Open `http://127.0.0.1:5173/?lod=/maps/lod-fixture/lod.json&players=off`.
Generated objects remain outside Git.

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
- Shadow coverage includes each rendered tile's full shaded area and its gutter,
  including coarse fallback levels. A finer cut waits for its required pages.
- Upload reservations survive native queuing. Retired GPU resources remain
  charged until asynchronous queue completion, without blocking navigation.
- Coarse coverage remains available while detail loads. Refinement is debounced;
  a 200 ms transition keeps both cuts resident until completion. Reduced motion
  uses atomic replacement.

This ledger is not browser RSS. Browser networking, JavaScript engine overhead,
compositor swapchains and driver allocations require separate process-level
measurement. Coarse inspection reports approximate heights and ranges, not an
exact material. Download failures retain available coverage and retry with
bounded backoff. Hidden documents suspend new loading and resume when visible.
Device loss cancels pending work and triggers one coarse-first reconstruction,
preserving the camera, lighting and independent player layer. A second loss or a
failed reconstruction requires an explicit Retry.

## Verification

```sh
npm run lod:test
cargo test --locked -p surface-core -p surface-cli lod
cargo test --locked -p surface-gpu
npx playwright test tests/lod.spec.ts tests/lod-failure.spec.ts
```

Native GPU tests require a wgpu adapter. Synthetic browser tests check rendering,
retirement, constrained admission, malformed responses and navigation recovery.
Their results do not establish reference-device performance.

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

See the [core format contract](../crates/surface-core/LOD.md) and
[GPU ownership and API contract](../crates/surface-gpu/LOD.md).
