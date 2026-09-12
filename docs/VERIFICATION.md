# Verification Checkpoint

Measured locally on September 11, 2026: Apple M1 Pro, 16 GiB RAM, macOS 26.3.
These are prototype measurements, not a speed comparison against uNmINeD.
The separate [visual comparison](VISUAL-COMPARISON.md) records geographic and
appearance checks against uNmINeD and the user's BedrockMap render.

Azimuth labels below use clockwise-from-north compass bearings throughout.
Historical tables have had only their angle labels converted, not their timings
or physical light directions. Older ignored JSON reports without a convention
tag retain their original east-origin angles and are not application input.

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

### Full Azimuth Follow-Up

The full 0-360 degree control replaces the NW-only shadow recurrence with a
direction-independent max-height hierarchy and accelerated per-sample ray
queries. Expressed in today's clockwise-from-north convention, that checkpoint's
default northwest bearing was 315. Surface format and imported data are unchanged.

Chrome 152.0.7977.83, 1920x1080 DPR1, 45-degree elevation, real beach centered at
X -284, Z -114, four pixels per block; all 64 regions resident:

| Azimuth | Frames in 5 seconds | Median / p95 / max interval (ms) |
| --- | ---: | ---: |
| 90 | 600 | 8.3 / 9.0 / 9.3 |
| 0 | 600 | 8.3 / 9.1 / 9.4 |
| 315 | 601 | 8.3 / 9.0 / 9.4 |
| 233 | 600 | 8.3 / 9.1 / 9.4 |
| 180 | 591 | 8.3 / 9.2 / 17.6 |
| 90 (wrapped) | 600 | 8.3 / 9.0 / 9.4 |

Resident accounting is 221,562,576 bytes (211.30 MiB), including the full hierarchy.
First populated frame was 251 ms in this warm run. An earlier new-build run at
spawn, scale 3, recorded 805 ms to first populated frame and 8.3/16.7/25 ms
median/p95/max navigation intervals; synthetic browser checks were also running
during that earlier sample. These are navigation cadence, not GPU timestamp
measurements, and not a guarantee of identical performance across terrain or
lower elevations. The algorithm now does variable-work close-up ray queries;
overview shading remains cached. Coverage uses four subpixel samples rather
than the previous special-case exact NW area integration.

No page/console errors or horizontal overflow were recorded in the six-angle
run. Desktop captures and a 390x844 lighting-panel screenshot are under ignored
`.local/azimuth/`; reproduce with `node scripts/check-azimuth.mjs`. Native Safari
was observed rendering that build at a 333-degree compass bearing with its controls open;
the user's camera and 60% shadow-strength setting were left unchanged. This was
a visual check, not a new Safari performance run. The matched NW beach reference
images were also refreshed with the current algorithm.

### Terrain-Edge Relief Follow-Up

The new artistic rim/corner highlights and lower contact bands follow azimuth
independently of primary cast shadows. Their default quarter-block width scales
with zoom. No import, codec, texture or source-world changes were needed.
See [APPEARANCE.md](APPEARANCE.md) for formulas and retained approximations.

Chrome 152.0.7977.83, real beach at X -284, Z -114, four pixels/block,
1920x1080 DPR1, 45-degree sun elevation, 55% cast shadows, all 64 regions loaded:

| Azimuth | Relief | Frames in 5 seconds | Median / p95 / max interval (ms) |
| --- | --- | ---: | ---: |
| 330 | Off | 600 | 8.3 / 8.8 / 9.3 |
| 330 | 100% | 600 | 8.3 / 8.9 / 9.7 |
| 150 | Off | 601 | 8.3 / 9.0 / 9.4 |
| 150 | 100% | 600 | 8.3 / 9.1 / 9.3 |

These are rAF navigation intervals, not isolated GPU execution costs or proof of
zero overhead. Shader/file caches were not flushed. First populated frame was
233 ms; accumulated worker decoding 284 ms. Resident map accounting remains
221,562,576 bytes (211.30 MiB). Relief adds no per-region memory allocation;
the small uniform grows by 16 bytes, outside that map-resource accounting.

The matched beach, close-up and reversed-sun captures were inspected against
the local uNmINeD reference: sand terraces now have light upper rims, bright
corners and dark lower contact bands. Tree highlights retain their green rather
than blending directly to white. No pixel-identical or speed advantage claim is
made. Six captures had 426-647 sampled RGB colors, no blank canvas or page/console
errors. The 390x844 and 844x390 layouts have no horizontal overflow; the settings
panel scrolls on the shorter viewport. Reproduce with `check-relief.mjs`.

Native Safari was visually checked in a separate tab with all 64 regions loaded,
then at a closer view with the relief/width controls and visible highlighted
terrain steps. The user interacted with that tab during verification; their
view was left in place. This is native-Safari visual evidence, not a new Safari
performance or automated interaction benchmark. No remote-automation setting
was changed. The original Safari tab was preserved.

### Sand Contrast and Default Follow-Up

At the user's request, the default was changed to 30 degrees west of north
(330 degrees in the current convention) in both the UI and initial GPU uniform.
Historical measurements above retain their original physical light direction.
Ordinary exposed sand in Vivid is 12% darker before rim composition;
other material grades, water blending and Original mode are unchanged. A browser
regression renders both classifications of the same synthetic scene and checks
the sand/edge contrast and non-sand pixel invariance. The matched real-beach
comparison is refreshed under `.local/relief/`; no world reimport is needed.

### Compass Dial Follow-Up

The implementation now takes clockwise-from-north bearings end to end, with a
330-degree default preserving the previous physical lighting. The CPU direction
function directly computes `(sin(a), -cos(a))` in X/Z; GPU passes consume that
shared vector. No old-angle UI adapter remains. Diagnostics name the convention.
The former linear range is replaced by a pointer-captured cyclic compass dial.

All 17 Rust tests and 13 Chrome browser tests passed locally. New independent
compass assertions cover cardinals, diagonals, the default, and multiple positive
and negative turns. Rendered pixels check explicit cardinal shadow directions.
Dial tests include three clockwise and two counterclockwise mouse revolutions,
dragging outside the control, center/right-click exclusion, touch rotation across
north, cancellation/restart, keyboard wrapping, and an unchanged map camera.
Touch events were injected in desktop Chrome, not tested on physical iPad hardware.

Before editing, the six 768x768 beach/close-up PNGs from checkpoint `749891b`
were retained under ignored `.local/azimuth-migration/before/`. After re-rendering
with equivalent compass bearings, **every decoded RGBA channel matched exactly**
in all six images, including relief off/on and reversed illumination. This is a
self-regression check, not a claim of pixel equivalence with uNmINeD.

Chrome 152.0.7977.83, matched real beach, 1920x1080 DPR1, warm caches:

| Azimuth | Relief | Frames in 5 seconds | Median / p95 / max interval (ms) |
| --- | --- | ---: | ---: |
| 330 | Off | 600 | 8.3 / 9.0 / 9.4 |
| 330 | 100% | 600 | 8.3 / 8.9 / 9.4 |
| 150 | Off | 600 | 8.3 / 8.9 / 9.2 |
| 150 | 100% | 601 | 8.3 / 9.0 / 9.5 |

First populated frame was 295 ms; worker decoding 281 ms. Map accounting remains
211.30 MiB. The separate eight-angle sweep recorded medians 8.3-8.4 ms,
p95 9.0-16.7 ms, and a 25 ms maximum while the Mac was also being used for Safari
inspection. These are observed navigation intervals, not isolated GPU timings
or an uncontended performance comparison. Both runs had no page/console errors.
Desktop, 390x844 and 844x390 captures showed a nonblank map, legible dial, no
horizontal overflow, and a scrollable settings panel in the short viewport.

Native Safari displayed the new dial and textured terrain at the user's current
331-degree bearing, 40-degree elevation and 65% shadow strength. Its accessibility
tree exposed the bearing and clockwise-from-north value description. The camera
and controls were left unchanged; this was a visual/accessibility check, not a
new automated Safari gesture or performance benchmark.

The initial CI run passed Rust/GPU checks and 11 browser cases but exceeded the
60-second per-test limit in two angle-heavy browser cases on SwiftShader. Pixel
tests now choose a bearing with a single real dial click instead of walking
through many intermediate keyboard values. The separate gesture test still
makes three clockwise and two counterclockwise turns, sampled at eight positions
per turn. Keyboard wrapping and fine touch steps remain separate assertions.
No test timeout, rendering assertion or application behavior was relaxed.

## Automated Checks

- Rust formatting and both native/WASM Clippy with warnings denied.
- Seventeen Rust tests: exact constant/mixed codec round trips, negative coordinates,
  missing coverage, corrupt/truncated payloads, decompression/window bounds,
  archive path/symlink rejection, leaf-litter support/overlay semantics, CPU
  shadow geometry and GPU equivalence.
- GPU ray fixtures compare five samples per cell against an independent CPU DDA
  for 15 azimuths and four elevations: flat terrain, a 10-block column, terraces,
  negative/missing randomized heights and a 256-column boundary. CPU tests verify
  conservative hierarchy maxima at odd dimensions, compass mapping, shadow
  reach, and retain the former NW analytical coverage reference.
- The same GPU fixtures validate relief against CPU band-intersection enumeration
  at three widths, subpixel/whole-cell footprints, negative/missing heights and
  region boundaries. CPU tests check stronger corners, partial-height steps,
  flat interiors, direction rotation and analytic band coverage.
- Thirteen Playwright tests: expected terrain/water pixels, fractional ledge shadows,
  sun azimuth/elevation/strength/color controls, exact 0/360 equivalence, shadow
  direction at cardinal/intermediate angles, full dial rotations with mouse/touch,
  touch cancellation/restart, pointer capture, 1-degree keyboard wrapping, picking, drag/wheel,
  negative coordinates, idle redraw, resize, toggles, device-loss recovery,
  download retry, checksum rejection, missing WebGPU, invalid manifests and raw
  world path denial.
- Relief pixel checks verify brighter corners, no interior plateau lines,
  opposite-side contact shade, 330-degree weighting, one/four-pixel bands at
  4/16 pixels per block, width/strength controls, overview invalidation, and
  water-step exclusion plus portrait/short-landscape panel fit. Cast-shadow tests disable independent
  relief so the two effects cannot mask each other's failures.
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
