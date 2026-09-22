# Incremental Terrain Synchronization

Terrain synchronization replaces changed 16x16 surface chunks without reloading
the map. It retains Mojang's official Bedrock Dedicated Server and operates
independently of [player tracking](TRACKING.md).

## Detection and Extraction

The separate `terrain/pack` uses block events as hints, then reads complete
surface columns to establish their contents. A rotating queue scans loaded
chunks around players for changes that events do not cover. It never reads live
LevelDB, creates ticking areas or forces chunks to load.

Every publication contains all 256 columns. Failed reads or unloading retain
last-known terrain for retry, not empty replacements. Piston `moving_block`
placeholders also invalidate the entire observation; a bounded rescan is queued
after 250 ms instead of publishing a temporary diagnostic material. Scanning spans ticks; it
is not a globally atomic world snapshot. `terrain/rules.json` shares material,
state and biome/tint rules with the offline adapter.

The native solid height map supplies a lower bound. Exact volume queries above
it include skipped water and thin blocks; underwater queries exclude water/air
while preserving plants and support. Fractional slab/snow heights and surface
overlays use the same retained-field definitions as offline extraction.

The pack's cooperative `scan_budget_ms` defaults to 1 ms and is configurable
from 1-4 ms. Its loop yields against an elapsed-time and query-count budget;
individual native calls are not preemptible. Pending completed observations are
bounded to 8 MiB, with only the latest per chunk. Health distinguishes unloads,
scan errors, transport failures, overflow and delayed coverage.

## Publication and Storage

- Each authenticated request carries world/generation, producer session, increasing
  sequence, scan interval and up to four complete chunks, bounded to 256 KiB.
  One request is in flight, with a two-second timeout and bounded backoff.
- The producer suppresses unchanged acknowledged content. Accepted observations,
  including unchanged ones, advance ordering metadata, not content revisions.
- SQLite holds current references, stable material IDs, observation watermarks,
  producer tombstones and reconciliation metadata. Immutable compressed objects
  are written and synced before their references commit.
- The root manifest references complete regions, height-only objects and regional
  chunk indexes. New visitors load current regions; connected viewers fetch
  changed chunks, without replaying an edit log.
- Material IDs append within a generation. `surface-sync refresh-catalog` updates
  descriptors without changing IDs or chunk hashes. Unknown materials stay visible
  as diagnostics.
- Backup reconciliation cannot overwrite a chunk with a post-boundary live
  observation, even when that observation's content is unchanged. Restoring or
  replacing a world requires an explicit new generation.

See [Format and Rendering](FORMAT.md) for BSC1/BSM2 layouts, bounded height windows,
atomic picking/GPU updates and shadow/overview invalidation. BSM1 offline maps
remain supported.

## Interfaces and Isolation

`surface-sync` has separate read and ingest listeners. The private ingest uses
`x-terrain-token`; neither it nor credentials belong in browser configuration.
The read API serves revalidated manifests/status and immutable hashed objects.
A fixed-destination HTTPS proxy exposes only approved GET/HEAD routes.

Every service command requires an explicit world ID and dataset generation via
`--world`/`TERRAIN_WORLD_ID` and `--generation`/`TERRAIN_GENERATION`.
The [operator configuration reference](CONFIGURATION.md#server-services-and-packs)
covers listener addresses, secret files, pack variables and the diagnostic packs'
required `allow_test_probe: true` opt-in on disposable worlds.

The pack uses server runtime `2.9.0` and net/admin runtime `1.0.0-beta`.
Exact npm declaration pins are in `package-lock.json`; declarations do not
establish BDS binary compatibility. Test candidate versions with the actual pack
on isolated fresh/restored worlds.

Deployment, secrets, resource limits, firewall, idle-only repair scheduling and
optional-pack update fallback belong in the operator's deployment repository
(`runproxmox` for the homelab), not in the application. The service needs only
its derived-store volume, not world files or a Docker socket. Terrain failures
must not interrupt gameplay or independent player delivery.

## Build and Validate

From a [bootstrapped checkout](GETTING_STARTED.md#run-the-demo-locally):

```sh
uv tool install ziglang==0.15.2
cargo install cargo-zigbuild --version 0.20.1 --locked
rustup target add x86_64-unknown-linux-musl --toolchain 1.92.0
npm run terrain:build
npm run terrain:test
cargo test --locked -p surface-sync
node scripts/terrain-fixture.mjs
npx playwright test tests/terrain.spec.ts
# Requires a clean committed checkout.
npm run terrain:bundle
```

The bundle contains static x86_64-musl binaries, packs and a synthetic seed, with
commit/hash verification metadata. Its importer supports isolated repair workers;
it contains no real terrain or Mojang textures.
`cargo run --release --locked -p surface-cli -- asset-library` prepares the
pinned shared atlas after the explicit [asset download](IMPORT.md).
The source CLI's `import --surface-only` emits region-streamed
repair data without a world-sized heightfield.

A live viewer requires a matching world/generation binding. Polling pauses while
hidden and revalidates on return. Outages preserve last-known terrain with a
separate freshness status. `?terrain=off` selects the offline snapshot;
`?players=off` disables positions independently.

The [acceptance checklist](TERRAIN-ACCEPTANCE.md) covers real edits, exploration,
outages and performance. Five-second direct edits, roughly sixty-second background
coverage and under 5% controlled-pan p95 degradation are targets to measure on
the deployment, not guarantees from synthetic tests.
