# Verification Checkpoint

Measured locally on September 11, 2026: Apple M1 Pro, 16 GiB RAM, macOS 26.3.
These are prototype measurements, not a speed comparison against uNmINeD.
The separate [visual comparison](VISUAL-COMPARISON.md) records geographic and
appearance checks against uNmINeD and the user's BedrockMap render.

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
| Region objects | 4,767,998 bytes |
| Region bytes per present column | 1.41560 |
| Complete compressed shadow heightfield | 709,165 bytes |
| Atlas | 265,201 bytes |
| Manifest | 172,987 bytes |
| Total above derived data | 5,915,351 bytes |
| Latest extraction stage | 12.567 seconds |
| Latest complete import | 13.736 seconds |
| Latest peak importer RSS | 426,475,520 bytes (406.7 MiB) |
| Native shared-decoder benchmark | 0.152 seconds for 64 regions |
| Identical content objects reused | 66; modification times unchanged |

After the visual-reference correction, leaf litter is retained as an overlay
over its actual supporting block. The extra cached per-chunk support queries
raised import time from roughly 11.5-12.6 to 13.7-14.0 seconds; two corrected runs
peaked at 374.1 and 406.7 MiB RSS. The lossless codec still round-trips every
retained field. All 832 raw-block samples and all 66 reuse checks still pass.
These are fresh archive extraction runs with cached assets and warm OS caches,
not a disk-cache-flushed benchmark. Compilation and the initial approximately
151 MB Mojang samples download are separate. The source archive is not modified.
Uncovered cells in the bounding rectangle remain missing, not empty terrain.
Zero unresolved textures does not imply perfect block-model/state appearance.

## Real Browsers

Both browsers were tested directly, not via a Linux WebKit substitute or the VDI.
Initial five-second controlled-pan samples, after map data loaded (before the
lighting follow-up below):

| Measurement | Chrome 152.0.7977.83 | Safari 26.3 |
| --- | ---: | ---: |
| Canvas backing resolution | 1920 x 1080 | 3840 x 2056 |
| Device pixel ratio | 1 | 2 |
| Animation frames / submitted draws | 600 / 600 | 300 / 300 |
| Median frame interval | 8.3 ms | 17 ms |
| 95th percentile interval | 9.0 ms | 18 ms |
| Maximum interval | 10.4 ms | 24 ms |
| Approximate navigation cadence | 120 Hz | 60 Hz |
| First populated frame, final run | 196 ms | 197 ms |
| Accumulated worker decoding | 275 ms | 239 ms |
| Resident map accounting | 204.55 MiB | 204.55 MiB |

Frame intervals measure requestAnimationFrame navigation cadence while submitting
draws, NOT GPU timestamp-query execution time. This meets the requested short
1080p DPR-1 navigation target in Chrome; it is not a guarantee for every browser,
long-duration workload or hardware configuration. Safari used a larger backing
resolution, so those frame-time rows are not an equal-resolution comparison.
Chrome was rerun after the leaf-litter import correction with all 64 regions and
no page errors. Safari's timings predate that data-only correction; its corrected
dataset was subsequently checked visually in native Safari without enabling
remote automation again.

First-frame latency starts at frontend module initialization and ends at the
next animation frame after wgpu reports completion of the first populated draw.
It excludes navigation/module transfer before initialization and is not a
physical display scanout measurement. Browser/OS shader and file caches were
not flushed; Safari reused an existing browser process. An earlier Chrome run
took 1,357 ms to first populated frame, so the final 196 ms warm result is not a
promise of cold-start latency. Earlier upload-only
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

### Adjustable Lighting Follow-Up

The fractional-shadow/Vivid-color build was measured again in Chrome
152.0.7977.83, with all 64 regions loaded and no page errors:

| Measurement | Updated Chrome |
| --- | ---: |
| Canvas / DPR | 1920 x 1080 / 1 |
| Sun elevation / shadow strength | 45 degrees / 55% |
| Animation frames / submitted draws | 600 / 600 |
| Median / 95th percentile interval | 8.3 / 9.1 ms |
| Maximum interval | 9.3 ms |
| First populated frame | 152.5 ms |
| Accumulated worker decode | 278.5 ms |
| Resident map accounting | 235,717,792 bytes (224.80 MiB) |

These remain animation-frame intervals, not GPU execution timings. First-visible
latency is a warm local run using the definition above. Changing the sun angle
retains the source height buffer, adding about 20.25 MiB to the earlier accounting;
the full map still fits the 256 MiB logical budget. Camera navigation does not
rerun shadow computation. Sun-angle interaction latency is not separately
benchmarked by this controlled-pan test.

Native Safari was reloaded and visually checked with the new shader and all 64
regions. Its native controls switched between 45/60 degrees and Vivid/Original,
then were restored to defaults. Its earlier performance timings are not new-build
measurements. Chrome
automated checks exercise the sliders and color selector, including screenshot
evidence of the change in one-block shadow reach. A real-beach comparison at
30/45/60 degrees and a 390 x 844 lighting-panel screenshot have no page errors or
horizontal overflow. See [APPEARANCE.md](APPEARANCE.md) for reproduction and limits.
The source archive's SHA-256 was rechecked unchanged; no reimport was needed.

## Automated Checks

- Rust formatting and both native/WASM Clippy with warnings denied.
- Thirteen Rust tests: exact constant/mixed codec round trips, negative coordinates,
  missing coverage, corrupt/truncated payloads, decompression/window bounds,
  archive path/symlink rejection, leaf-litter support/overlay semantics, CPU
  shadow geometry and GPU equivalence.
- GPU fixtures compare flat terrain, isolated 10-block column, terraces,
  one-block ledges at 45/60 degrees, and a missing sample at a 256-column region
  boundary. CPU analytical coverage also agrees with an independent ray walker.
- Seven Playwright tests: expected terrain/water pixels, fractional ledge shadows,
  sun elevation/strength/color controls, picking, drag/wheel,
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

The lighting follow-up's first CI run passed the new ledge-pixel and native GPU
checks but exposed a race in the existing idle test: a final queued draw arrived
after its fixed 200 ms settling delay. The test now waits for region loading and
two animation-frame boundaries before starting its unchanged zero-redraw check.

## Remaining Limits

No live updates, players, public hosting, authentication or homelab deployment.
Biome tint interpolation and complex/translucent block models remain documented
top-surface approximations. Overview filtering is per region. A much larger
visible dataset may exceed the resident cache and require zooming in; a separate
overview-only residency tier is not implemented. Shadows invalidate by full
snapshot reload, not a fine-grained live dependency graph. Map-memory accounting
does not include total browser/driver RSS or transient decode allocations.
