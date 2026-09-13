# Terrain and Player Acceptance

Use this checklist for a release or deployment review. Automated tests, isolated
BDS checks and real-client acceptance serve different purposes; none substitutes
for the others. Attach measured results and exact revisions to the relevant PR,
with private artifacts outside Git.

## Application Checks

Run the [development suite](DEVELOPMENT.md#verify) and check these invariants:

- Complete chunk replacement agrees with picking and shadows, including negative
  coordinates, region boundaries, roof removal, water/support, overlays and
  fractional heights. Unavailable reads never erase last-known terrain.
- Material IDs remain stable, default variants normalize consistently and
  unknown materials are visible diagnostics. Catalog refresh is idempotent.
- Unchanged observations do not publish a new content revision, but protect
  against an older backup replacement. Reordered sessions and duplicate writes
  cannot overwrite current state.
- Player-only movement and unchanged terrain polls produce no stationary terrain
  draws. Chunk updates preserve camera, lighting, selected player and follow.
- Player and terrain outages have independent status and recovery. Expired objects
  cause revalidation; neither feed requires a page reload to resume ordinary updates.

The unit and browser tests use synthetic input. They do not establish retail
client compatibility or edit-to-visible latency on a game server.

## Isolated Server Gate

Use a fresh world and a separate restored copy before enabling a candidate in
production. Verify the installed BDS binary and API pins. Keep test credentials,
world ID and services separate; do not attach public game tunnels or friend
discovery. Diagnostic probe packs belong only on disposable worlds.

Compare all retained fields of complete live chunks against offline extraction
after material normalization. Include roof removal, water and plants, slabs,
snow, piston/explosion effects and new coverage. Trigger edits and natural
changes, interrupt collection, and confirm eventual correction after recovery.
Measure scan duration, queue age, query count, memory and game tick impact.

Check authentication before body processing, body/time/concurrency limits and
read-listener rejection of writes. Containers need non-root execution, read-only
root filesystems, dropped capabilities and no live-world or Docker mounts.
Storage exhaustion must preserve current references and leave gameplay running.

Experiment activation requires a consistent backup and explicit operator
approval. Removing a pack does not remove the world's experimental status.
Production changes use the deployment runbook's idle gate, maintenance lock,
UDP fence, stopped backup, health checks and independent recovery timer.

## Real Clients and Recovery

1. Connect two approved accounts on distinct devices. Compare map/game coordinates,
   including negative positions and a dimension transition. Click each roster name,
   test follow, and verify manual navigation cancels it.
2. Make visible block edits and explore unmapped terrain. Confirm terrain, shadows,
   picking and player alignment update without reloading in Chrome, native Safari
   and the physical iPad.
3. Observe a stationary player during a collector outage: stale state at ten
   seconds, no coordinates after thirty, then recovery. A failed feed must not
   appear as a healthy empty roster.
4. Interrupt terrain collection separately. Confirm last-known terrain remains,
   player delivery continues and missed changes appear after recovery or repair.
5. Check daily repair's backup/live ordering, independent disable paths and
   optional-pack fallback for an otherwise healthy BDS upgrade.

Outage tests require separately authorized service control and a recovery plan.
The read-only `scripts/check-tracking-outage.mjs` observer supports
`--service tracking` or `--service terrain`; it does not stop services.
It and `check-live-tracking.mjs` have installation-specific URL/dataset assumptions.
Review those source settings before use; they are not portable deployment tools.

## Browser and Growth Measurement

For a configured local viewer, run ABBA comparisons serially:

```sh
node scripts/check-tracking-performance.mjs --url http://127.0.0.1:5173/ --scope combined --browser chrome
node scripts/check-tracking-performance.mjs --url http://127.0.0.1:5173/ --scope combined --browser safari
node scripts/check-terrain-growth.mjs
```

The performance script accepts loopback origins and an installation-specific LAN
origin. Native Safari requires an explicitly enabled WebDriver on port 4444 and
a foreground window. Combined scope compares offline/players-off with
live-terrain/players-on at the same camera and physical canvas size. Record the
actual player count and edit load: idle-feed timing does not measure active edits.

The growth script generates dense synthetic 4x and 16x maps, pans through 26
locations per map and checks bounded residency, picking and zoom-in recovery.
The 256 MiB budget covers accounted map allocations, not total browser/driver
RSS or transient decoder peaks. Oversized views must ask for zooming in rather
than omit required shadow coverage.

Measure direct-edit and background freshness separately, including sampling,
transport and browser application delay. Targets are five-second direct updates,
approximately sixty-second active-area coverage and less than 5% pan p95
degradation. Report p50/p95/max, transfer bytes, memory, resolution, DPR and server
load. Animation-frame intervals are not GPU execution timestamps.

Keep the physical iPad's 60 FPS refresh preference fixed for the baseline;
high-refresh behavior is a separate test. Desktop emulation, empty-server timing
and two-player samples do not establish physical-iPad or eight-player performance.
See the [verification guide](VERIFICATION.md) for general measurement definitions.
