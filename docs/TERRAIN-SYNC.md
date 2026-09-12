# Incremental Terrain Synchronization

Implementation of the September 12 accepted specification. This is separate from
the already deployed player tracker. Source checkpoints are not production rollout
or retail-client acceptance evidence.

## Contract

- One complete 16x16 surface chunk per replacement; no block-operation journal.
- SurfaceChunk BSC1 uses the existing constant/palette/bit-packed channel encoding
  and Zstandard. BSM2 retains the 256x256 region representation and adds coverage
  value 2 (verified empty). BSM1 remains readable and retains its original bytes.
- Column order: coverage, top in sixteenths, material, RGB tint, biome, overlay
  material, overlay top, water depth, support material, support top. Coverage 0
  remains unavailable, not air; -32768 is the absent-height sentinel.
- Live manifests use format_version 2 and explicitly bind world_id and generation.
  Material IDs append within that generation. Source hashes are provenance, not
  player-binding identities. New/replaced worlds require a new generation/state.
- Root manifests reference regional indexes, complete current region objects and
  height-only objects. Regional indexes also reference current chunk objects.
  Existing clients fetch changed chunks; cold loads use complete regions.
- SQLite stores only current references, observation watermarks and bounded
  producer tombstones. Objects are written and synced before references commit.
  A newer accepted observation wins over a backup even if its content is unchanged.

## Components and Security

`terrain/pack` is an independent read-only BDS script pack. `terrain/rules.json`
declares the surface classification and biome/tint mapping. The pack uses existing
2.9.0 server and 1.0.0-beta net/admin runtime dependencies, with the previously
pinned npm declarations. Additional API compatibility still requires a BDS test.

`surface-sync` has separate ingest/read routers; its intended VM100 publication is
read-only LAN TCP8111. The private ingest uses x-terrain-token, a 256 KiB body limit,
at most four complete chunks per request, and never logs payloads or credentials.
Deployment and daily repair belong in runproxmox, not this application repository.

## Verification Stages

- Protocol/extraction: exact codec round trips, unavailable/empty distinction,
  roof removal, water/support, overlays, fractional heights, reordered uploads,
  producer changes, material identity and backup/live conflicts.
- Storage/viewer: immutable object validation, bounded storage, chunk GPU/picking
  patches, shadow/overview invalidation, sparse world growth and cache bounds.
- Operations: isolated fresh/copy tests, optional-pack update fallback, daily
  04:45 local idle-only repair with the existing maintenance guards, failure
  monitoring, explicit disable paths and tested production activation.
- Real acceptance: edits, new terrain and outage repair visible in Chrome, Safari
  and the iPad without reload. Five-second direct-edit latency and <5% controlled
  pan p95 degradation are targets until measured, not claims from synthetic tests.

Terrain synchronization never reads live LevelDB or forces chunks to load. It does
not publish the map on the internet, collect inventories/chat, or retain movement
history. Keep snapshots, terrain objects, textures and all credentials outside Git.
