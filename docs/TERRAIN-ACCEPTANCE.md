# Terrain Acceptance Record

September 12, 2026. Implementation remains under review in PR 3; this is not a
production rollout or complete device acceptance claim.

## Copied-World Engine Gate

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
camera preservation and sparse distant growth. Dense 4x/16x worlds, active-update
pan timing, Safari, M4 iPad, real player edits/new exploration and the full daily
repair workflow remain separate acceptance gates.
