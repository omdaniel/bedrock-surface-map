# Terrain Acceptance Record

September 12, 2026 (production activation September 13, 02:43 UTC). Implementation
remains under review in PR 3. Production is active; complete real-client/device
acceptance is not implied by the automated evidence below.

## Production Integration

- Production terrain pack 1.0.2 and service use application
  `a4d2da69ea08a8879111dd1a4a66f989284d0e3d`. Player tracking remains independently
  pinned to `71d8e2b97ddcfdb4faf5ad13cfb4d8d543e73876`, pack 1.0.1.
- The ordinary HTTPS map at `https://192.168.68.110:8443/` binds both feeds to
  `bedrock-survival` / `bedrock-survival-20260912`. Terrain is on VM100 TCP 8111,
  players on TCP 8110. The separate Creative test copy remains on game UDP 19134,
  terrain TCP 8113, players TCP 8112 and viewer HTTPS 8445.
- Guarded activation reran both isolated candidates, admitted an idle minute,
  fenced UDP and verified backup `20260913T024312-e0bc88c7` before registration.
  No version upgrade, experiment toggle, game-mode or access-policy change.
- Initial repair reused that stopped backup without another game restart. It
  checked 13,157 chunks and refreshed 1,976 in 148.2 seconds including archive
  preparation, low-priority extraction and publication. No live observation
  needed protection in this empty-server run; backup/live races have unit coverage.
  The derived snapshot fingerprint changed while player binding stayed valid.
- Publication briefly caused five terrain HTTP retries; current heartbeats
  recovered without a game or player-collector restart. These cumulative errors
  are not ongoing scan failures. Daily idle-only repair and five-minute degraded
  health monitoring are enabled; the host health evaluator reported no issues.
- Both services passed deployed non-root/read-only/capability/mount checks.
  Ingestion is unpublished on separate internal networks, wrong tokens return 401,
  read listeners reject ingestion, and the HTTPS proxy rejects writes/wrong worlds.
- Guarded 35-second production terrain outage: seven unchanged healthy-game
  checks and independent player health passed. Chrome recovered without reload,
  retained camera/cache, produced zero terrain draws, and reported 92 fresh player
  UI checks. All 31 observable player response bodies were fresh; Chrome's debugger
  could not retrieve 14 already-consumed streamed bodies, which are recorded as
  missing capture evidence rather than stale responses. Independent HTTPS sampling
  returned 15/15 live responses, maximum sample age 1989 ms. No player movement was
  synthesized. The independent restart watchdog was disarmed after restoration.
- Pause the empty acceptance game before resource-heavy isolated candidate gates;
  it temporarily reduced VM100 headroom below the existing 850 MiB admission
  threshold. The gate did not change production. No memory limit was weakened.

### Repeatable Browser Measurement

Run these serially, with Safari foreground and its existing WebDriver on 4444:

```sh
node scripts/check-tracking-performance.mjs --scope combined --browser chrome
node scripts/check-tracking-performance.mjs --scope combined --browser safari
```

The ABBA check compares offline-viewer/players-off with live-terrain/players-on at
the same camera and physical canvas size. It records p50/p95/max frame intervals,
map allocations, unchanged-poll draws and roster count. This compares the two
reader paths; it is not a controlled eight-player or continuous-edit benchmark.
Private JSON/screenshots stay in `.local/tracking`. Never run competing GPU
benchmarks concurrently. A background-window timing timeout is not an FPS result.

Mac Safari 26.3, foreground, 1920x1080 physical canvas at native DPR 2: offline
p95 18/17 ms, integrated p95 17/18 ms. All four runs had zero unchanged-poll draws
and no failed downloads. Integrated map residency was 264,042,784 bytes. Maximum
frame intervals reached 93/99 ms in integrated runs and 18/82 ms offline, so this is
not a claim of perfectly uniform frame delivery. There were no players or live
edits during the measurement. The earlier hidden-window timeout was identified
through `document.visibilityState`; the harness now requires visibility explicitly.

Chrome 152, 1920x1080/DPR 1, repeated after repair: offline p95 16.8/16.7 ms;
integrated p95 16.7/16.8 ms. All four runs had zero unchanged-poll draws and no
download failures. Integrated map residency was 264,042,784 bytes; maximum frame
interval was 16.8 ms. These idle-feed comparisons did not show a p95 regression;
the less-than-five-percent active-edit/player target remains unmeasured.

## Combined-Feed Regression Checkpoint

- Corrected live `sand_type=normal` and `dirt_type=normal` canonicalization and
  moved texture-name resolution into shared Rust code. Default variants reuse
  sand/dirt textures; red sand and coarse dirt remain distinct.
- `surface-sync refresh-catalog` repairs descriptors of already-published material
  IDs without changing chunk hashes, IDs or dataset generation. Its idempotence
  and root-catalog publication are covered by a persistent-store regression test.
- Pack 1.0.1 distinguishes expected unloads, scan errors and HTTP failures. Health
  includes completed scans, active coverage and last/max scan duration. A fresh
  heartbeat no longer masks delayed scan coverage.
- Real Chrome synthetic integration verifies simultaneous terrain/player updates,
  stable camera/selection/follow, marker projection, zero terrain draws on player
  movement, independent feed outages and expired region-object retry. This is
  browser integration evidence, not an assertion that real clients were tested.

## Copied-World Engine Gate

### Stabilization Build

Application `a4d2da69ea08a8879111dd1a4a66f989284d0e3d`, pack 1.0.2, BDS 1.26.45.1:

- The shipping pack, without the probe pack or players, observed an actual piston
  change/new chunk in 0.783 s. Recovery after an eight-second collector outage was
  1.276 s in this run; exponential retry backoff can take longer (up to 30 s).
- Restored-copy probe: roof removal 3.031 s, recovery 3.031 s, 256/256 complete
  columns matching offline extraction across all retained fields. Native-query
  scan measurements: 446, 402, 1105, 400, 403, 403 ms. These are collector timings,
  not a measured real-client edit-to-browser p95.
- Underwater lookup uses the native solid lower bound plus a filtered volume query;
  it preserves underwater plants/support and no longer reads each water voxel.
  An additional real ocean chunk matched all ten fields in all 256 columns.
- Test-copy catalog repair corrected two published descriptors. Chrome and Safari
  show ordinary sand instead of magenta. Both test feeds use the same world and
  generation, with independent private ingestion networks and fresh test secrets.

### Working-Window Stress

`node scripts/check-terrain-growth.mjs` generates dense synthetic maps using the
shared Rust codec, then pans Chrome at 1920x1080/DPR1 through 26 locations each:

- 4x: 256 regions / 16,777,216 columns; 16x: 1,024 regions / 67,108,864 columns.
- Maximum accounted map residency: 268,221,480 bytes (255.8 MiB), with nonvisible
  detail evicted at the ceiling. The height window moved instead of allocating
  either world's full bounding rectangle. This is accounted map memory, not total
  browser process RSS or instantaneous decoder/driver allocation peaks.
- Oversized fit-world views explicitly required zooming in; spawn navigation
  recovered without reloading. No page errors or failed region downloads.
- Mac Safari 26.3 on the HTTPS pilot passed rendering, picking, drag and device-loss
  recovery. Its measured controlled-pan p95 was 30 ms at DPR2/3840x2056; this is not
  the specified 1080p/DPR1 baseline or an iPad result.

### Earlier Build

Application `3bfca666a9e1c675380df7030cfa5fe7dd9a8cac`, official BDS 1.26.45.1,
VM100 isolated containers, no published game ports. Input snapshot SHA-256:
`d6c03baf7b4bb7a621e85f0acf073abe737bd3789db26505e4268386fee12097`.

- Fresh baseline game healthy; separate terrain pack authenticated heartbeat passed.
- All 256 columns matched offline extraction across all ten retained fields after
  material normalization: roof removal, water/support, snow, slab, grass and litter.
- Roof removal appeared at the collector in 3.028 seconds. After an eight-second
  collector outage, a changed roof appeared 3.030 seconds after collector restart.
  The game did not restart during the outage. These are probe-to-collector timings,
  not browser edit-to-visible latency or real-player event acceptance.
- Cooperative budget 4 ms, hard ceiling 256 native queries per tick. Five measured
  complete scans: 397, 1452, 346, 446 and 459 ms. Five early unloaded-chunk retries
  occurred before the test-only ticking area finished loading; no incomplete data
  replaced the map. Production does not create ticking areas.
- The initial 1 ms experiments were slower: exact whole-column volume enumeration
  took roughly 16-23 seconds; downward ray queries took roughly 9-32 seconds.
  The chosen exact query uses the native solid height map as a lower bound, then
  checks the volume above it for skipped water/thin blocks. It never treats the
  solid height map as the final surface.
- The pinned parser's surface-biome helper ignores ID 0. The adapter instead reads
  its decoded biome storage at the support height, preserving valid ocean ID 0.
  Live legacy default state fields are normalized using versioned shared rules;
  conflicting/nonredundant state values are retained.

## Local Chrome Comparison

Real Chrome 152.0.7977.83 on M1 Pro, 1920-wide canvas at DPR 1, high-refresh desktop.
Existing snapshot rendered through offline and live formats, without live writes.
Three controlled-pan p95 intervals: offline 10.1/10.1/10.3 ms; live 10.1/10.1/10.1 ms.
Full initial region loading: 665 ms offline, 883 ms live in this local run.
Logical map allocations: 249,874,688 versus 264,042,496 bytes. The latter is below
the 256 MiB ceiling but leaves little room at the fit-world view. These counters do
not represent total browser/driver process memory. Texture, water and relief
screenshots were inspected. Raw screenshots/measurements stay in ignored `.local`.

Synthetic browser tests pass chunk replacement/picking, unchanged-poll no-redraw,
camera preservation and sparse distant growth. Dense growth, Mac Safari and the
production repair run are recorded above. Real-client edits/new exploration,
active-update pan timing, M4 iPad timing and measured server tick impact remain
separate acceptance gates. No client was connected during this rollout; existing
two-player production marker acceptance predates the terrain addition.
