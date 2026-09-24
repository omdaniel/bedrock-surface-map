# Verification Guide

Verify correctness with synthetic fixtures, then measure the intended dataset
on real browsers and hardware. Test results belong with the exact commit or PR;
this guide describes the checks and their limits, not a record of past runs.

## Automated Coverage

Run the [development checks](DEVELOPMENT.md#verify) from a bootstrapped checkout.
The suite covers:

- Lossless codecs, negative coordinates, unavailable/empty coverage, malformed
  payloads, decompression bounds, archive safety and surface classification.
- CPU/GPU shadow agreement, compass directions, fractional shadow reach,
  odd-sized height pyramids and region boundaries.
- Relief bands, corners, fractional heights, sand contrast, water exclusion,
  filtering and lighting controls.
- Pixel output, picking, navigation, idle redraw, resizing, download failures,
  checksum rejection, missing WebGPU and device-loss recovery.
- Player ordering/expiry, safe labels, roster/follow controls, terrain chunk
  replacement, backup/live ordering, bounded growth and independent feeds.
- Public-demo playback, packet integrity, subpath loading and artifact isolation.

GitHub Actions runs native/WASM checks and synthetic browser tests on Linux.
Browser presentation uses Chromium under Xvfb with software Vulkan. Tests wait
for completed GPU work and inspect pixels; a submitted draw alone is not proof
of visible output. CI does not use private worlds, Mojang textures or homelab
credentials. It does not measure native Mac or iPad GPU performance.

## Offline Import

Use a consistent archive and the [import commands](IMPORT.md). Record its hash
before and after import, require a successful exit and inspect the JSON report.
Check chunk/column coverage, unresolved materials and independent raw-block
samples. Repeat the import to check content-addressed object reuse.

Keep these measurements separate: compilation, asset download, archive/import
time, peak importer RSS, compressed bytes per present column and decoder time.
State whether filesystem caches are warm. Compression is exact for retained
surface fields, not the underground world or unrelated world records.

The [visual comparison procedure](VISUAL-COMPARISON.md) checks geographic and
appearance plausibility without treating another renderer as an exact oracle.

## Native Browser Checks

With the local viewer running and the relevant map loaded:
set `MAP_URL` or use [operator configuration](CONFIGURATION.md) to select the
viewer and report directory. HTTPS targets can use any operator-selected hostname
or LAN address; there is no homelab-specific URL allowlist.

```sh
node scripts/check-browser.mjs
node scripts/check-appearance.mjs
node scripts/check-azimuth.mjs
node scripts/check-relief.mjs
```

For native Mac Safari, explicitly enable its remote automation permission and
start `/usr/bin/safaridriver -p 4444` separately, then run
`node scripts/check-safari.mjs`. `MAP_URL` selects the URL and `MAP_EVIDENCE`
selects its local output directory. Restore the automation setting after testing.

Inspect actual textures, water, ledges, picking, pan/zoom, lighting, resizing,
download recovery and device loss. Check portrait and short-landscape controls
for clipping and overlap. Mobile-layout emulation is not physical iPad testing.
Private screenshots and raw reports stay under ignored `.local/`.

For LAN HTTPS, use [Temporary LAN Preview](GETTING_STARTED.md#temporary-lan-preview).
Verify the certificate on the actual client and confirm private keys, raw worlds
and Git paths cannot be retrieved. Only the public CA certificate is distributed;
the preview does not change trust stores automatically.

## Performance Method

Use a foreground browser, fixed camera, dataset, lighting and physical canvas
resolution. Run competing GPU workloads separately. Record browser/OS/GPU,
device pixel ratio, refresh preference and cold/warm cache conditions with results.

| Metric                 | Meaning                                                                                                                                                  |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First populated frame  | Frontend initialization to the animation frame after completion of the first populated GPU draw; excludes preceding module transfer and physical scanout |
| Navigation p50/p95/max | Animation-frame intervals while submitting controlled-pan draws, not GPU execution timestamps                                                            |
| Worker decode time     | Accumulated transport decoding, separate from download and first-visible latency                                                                         |
| Accounted map memory   | Resident map resources, not total browser/driver RSS or transient allocation peaks                                                                       |
| Transfer size          | State whether bytes are encoded network transfer, response bodies or the complete published artifact                                                     |

The rendering target is smooth 60 FPS at 1920x1080, DPR 1, after loading, not a
guarantee across devices or scenes. Do not infer a speed advantage over another
renderer without equivalent input, workload, settings and hardware. Live-feed
acceptance and active-update performance use the separate
[terrain and player checklist](TERRAIN-ACCEPTANCE.md).

## Limits to Check

Biome interpolation, complex models, water layers and canopy shading are
top-surface approximations. Overview filtering is per region. Very wide live
views can exceed the 256 MiB logical map budget and require zooming in; there is
no separate overview-only residency tier. Offline and live height coverage differ
as described in [Format and Rendering](FORMAT.md).

Player and terrain feeds require explicit configuration. The public demo uses
simulated activity, not a live server. The viewer has no built-in account system;
the [reference HTTPS gateway](DEPLOYMENT.md) supplies shared-password access by
default, while the temporary LAN preview supplies no authentication.
Synthetic checks do not establish retail-client compatibility, server tick
impact or physical-device acceptance. Include those checks in deployment review.
