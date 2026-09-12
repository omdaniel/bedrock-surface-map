# Verification Checkpoint

Measured locally on September 11, 2026: Apple M1 Pro, 16 GiB RAM, macOS 26.3.
These are prototype measurements, not a comparison against uNmINeD.

## Checkpoints

1. `21e30b8`: Rust 1.92.0 workspace, exact codec and CPU shadow fixtures.
2. `e109bfa`: real-world read-only import, texture preparation and safety tests.
3. `52ae751`: working WASM/WebGPU viewer, browser tests and synthetic-only CI.
4. This verification checkpoint: final browser measurements, bounded network
   reads, GPU-completion-aware first-frame latency and error-path hardening.

## Real Export

Input: `Bedrock-Survival-2026-09-11.mcworld`, 68,821,121 bytes.
SHA-256 before and after extraction:
`d6c03baf7b4bb7a621e85f0acf073abe737bd3789db26505e4268386fee12097`.

| Measurement | Result |
| --- | ---: |
| Overworld chunks | 13,157 |
| Present surface columns | 3,368,192 |
| Published regions | 64 |
| Bounding rectangle columns | 5,308,416 |
| Material/state catalog entries | 366, including the diagnostic sentinel |
| Unresolved encountered texture names | 0 |
| Raw-block sample checks | 832 passed |
| Region objects | 4,731,910 bytes |
| Region bytes per present column | 1.40488 |
| Complete compressed shadow heightfield | 736,100 bytes |
| Atlas | 265,756 bytes |
| Manifest | 173,002 bytes |
| Total above derived data | 5,906,768 bytes |
| Latest extraction stage | 10.367 seconds |
| Latest complete import | 11.543 seconds |
| Latest peak importer RSS | 412,418,048 bytes (393.3 MiB) |
| Native shared-decoder benchmark | 0.175 seconds for 64 regions |
| Identical content objects reused | 66; modification times unchanged |

Earlier complete runs took 11.9-12.6 seconds; peak RSS varied roughly 375-440 MiB.
These are fresh archive extraction runs with cached assets and warm OS caches,
not a disk-cache-flushed benchmark. Compilation and the initial approximately
151 MB Mojang samples download are separate. The source archive is not modified.
Uncovered cells in the bounding rectangle remain missing, not empty terrain.
Zero unresolved textures does not imply perfect block-model/state appearance.

## Real Browsers

Both browsers were tested directly, not via a Linux WebKit substitute or the VDI.
Final five-second controlled-pan samples, after map data loaded:

| Measurement | Chrome 152.0.7977.83 | Safari 26.3 |
| --- | ---: | ---: |
| Canvas backing resolution | 1920 x 1080 | 3840 x 2056 |
| Device pixel ratio | 1 | 2 |
| Animation frames / submitted draws | 600 / 600 | 300 / 300 |
| Median frame interval | 8.3 ms | 17 ms |
| 95th percentile interval | 9.0 ms | 18 ms |
| Maximum interval | 9.4 ms | 24 ms |
| Approximate navigation cadence | 120 Hz | 60 Hz |
| First populated frame, final run | 1,357 ms | 197 ms |
| Accumulated worker decoding | 308 ms | 239 ms |
| Resident map accounting | 204.55 MiB | 204.55 MiB |

Frame intervals measure requestAnimationFrame navigation cadence while submitting
draws, NOT GPU timestamp-query execution time. This meets the requested short
1080p DPR-1 navigation target in Chrome; it is not a guarantee for every browser,
long-duration workload or hardware configuration. Safari used a larger backing
resolution, so those frame-time rows are not an equal-resolution comparison.

First-frame latency starts at frontend module initialization and ends at the
next animation frame after wgpu reports completion of the first populated draw.
It excludes navigation/module transfer before initialization and is not a
physical display scanout measurement. Browser/OS shader and file caches were
not flushed; Safari reused an existing browser process. Earlier upload-only
latency readings were discarded as overly optimistic.

Validation included real textures, water/depth appearance, canopy surfaces,
block inspection, north-up pan/zoom, fit/spawn, grid/shadow toggles, zoom filtering,
resize and actual GPU-device destruction/recreation. Safari WebDriver pointer
drag moved the camera and picking returned a water column; Chrome interaction
tests exercised the DOM controls and wheel/drag navigation. Screenshot pixel
sampling found 4,693 distinct interior RGB values in Chrome and 8,703 in Safari,
confirming nonblank output; screenshots were also visually inspected.

Desktop and 390 x 844 mobile-layout screenshots are local under
`.local/verification`. The mobile layout has no horizontal overflow. It is NOT
a test of iPad hardware, mobile Safari WebGPU, touch latency or mobile memory.
Safari remote automation was enabled temporarily for the test and restored off.

## Automated Checks

- Rust formatting and both native/WASM Clippy with warnings denied.
- Ten Rust tests: exact constant/mixed codec round trips, negative coordinates,
  missing coverage, corrupt/truncated payloads, decompression/window bounds,
  archive path/symlink rejection, CPU shadow geometry and GPU equivalence.
- GPU fixtures independently compare flat terrain, isolated 10-block column,
  terraces, and a missing sample at a 256-column region boundary.
- Six Playwright tests: expected terrain/water pixels, picking, drag/wheel,
  negative coordinates, idle redraw, resize, toggles, device-loss recovery,
  download retry, checksum rejection, missing WebGPU, invalid manifests and raw
  world path denial.
- WASM release compilation and Vite/TypeScript production build.
- Gitleaks staged/history hooks, ignored-artifact checks and clean `runproxmox`.

GitHub Actions repeats source checks with synthetic data on Ubuntu/Mesa and
Chromium. Consult the PR checks for the latest run status; no CI result should
be interpreted as the Mac hardware measurements above. No raw worlds, Mojang
assets or local screenshots are sent to CI.

The first Linux run exposed test portability issues: exact screenshot bytes
without a GPU-completion wait, and a nonexistent Mac path falling through Vite's
SPA route. Checks now wait for the first completed GPU frame, allow two RGB
quantization levels, and create a real synthetic private file outside the web
root on each platform. CI uses the SHA-verified official wasm-bindgen 0.2.127
binary and the already-tested debug CLI for fixture generation, avoiding redundant
tool and native-release compilation. Real import benchmarks still use release.

For Linux screenshot presentation, CI uses headed bundled Chromium under Xvfb
and an explicit SwiftShader/Vulkan adapter with Vulkan surfaces disabled. This
follows the [first-hand VGPU validation recipe](https://github.com/vercel-labs/vgpu/issues/109)
and [Chrome's headless GPU guidance](https://developer.chrome.com/blog/supercharge-web-ai-testing).
Page-side GPU completion alone is not accepted as evidence of visible pixels.
These isolated synthetic-CI flags are not applied to ordinary Mac browsing and
are not hardware acceleration benchmarks.

## Remaining Limits

No live updates, players, public hosting, authentication or homelab deployment.
Biome tint interpolation and complex/translucent block models remain documented
top-surface approximations. Overview filtering is per region. A much larger
visible dataset may exceed the resident cache and require zooming in; a separate
overview-only residency tier is not implemented. Shadows invalidate by full
snapshot reload, not a fine-grained live dependency graph. Map-memory accounting
does not include total browser/driver RSS or transient decode allocations.
