# Player Tracking Technical Reference

Protocol, build and integration details for operators and contributors.
For map controls and requirements, start with [Live Player Tracking](TRACKING.md).

## Pack and Collector

`surface-tracker` stores one bounded full-roster snapshot in memory.
Its private `/ingest/v1/snapshot` listener requires the `x-tracker-token` header.
The independent read listener serves
`GET/HEAD /api/v1/worlds/{world_id}/players` and `/healthz` with `no-store`.
It uses no database, world files, inventories, chat, XUIDs or movement history.

Schema 1 is defined by the Rust types and
[the synthetic snapshot fixture](../fixtures/tracking/snapshot.json).
Ingest is capped at 16 KiB/32 players. Producer epoch, sequence and sample-time
checks reject obsolete data. Coordinates expire after thirty seconds, including
in collector memory; an ordering high-water mark retains no player positions.
Health retains aggregate counters and the pack version. Gamertags are text,
never HTML.

Authentication precedes body collection. Ingest has one request slot and a
two-second body/handler deadline; the read listener has sixteen slots with the
same deadline. Unauthorized, oversized and slow requests do not replace the roster.

The pack samples every forty ticks and coalesces roster events. It allows one
two-second HTTP request at a time, with no backlog and a maximum thirty-second
retry backoff. Empty-roster heartbeats distinguish idle from broken.
The [sampler](../tracking/pack/src/core.ts) accepts an operator-configured
`excluded_players` array; its default excludes nobody. Bedrock yaw becomes
north-zero, clockwise heading with `(yaw + 180) mod 360`.

## Browser Behavior

The browser polls every two seconds while visible. Samples become stale at ten
seconds and lose coordinates/markers at thirty, even if HTTP requests succeed.
An empty successful snapshot removes players immediately.

Markers use fixed CSS-pixel sizes and the terrain camera transform. Ordinary
movement interpolates for 250 ms without prediction; teleports, respawns and
dimension changes snap. Player-only updates do not request a terrain frame.
Follow moves the camera, so it redraws terrain.

Tracking is independent of terrain updates. Offline maps bind to a snapshot
fingerprint; live maps bind to world ID and generation. Unbound maps do not
silently enable tracking. Known regions awaiting download say "terrain not
loaded", distinct from positions outside mapped coverage. Errors and retry
controls remain separate from the roster.

## Build and Compatibility

From a [bootstrapped checkout](GETTING_STARTED.md#run-the-demo-locally):

```sh
npm run tracking:build
npm run tracking:test
cargo test --locked -p surface-tracker
npm test
rustup target add x86_64-unknown-linux-musl --toolchain 1.92.0
# Requires a clean committed checkout; uses Rust's bundled linker.
npm run tracking:bundle
```

The ignored `.local/tracking/bundle` contains the static Linux collector,
pack, diagnostic probe and per-file SHA-256 manifest tied to the application
commit. Verify hashes and commit before deployment. It contains no credentials
or world data; the collector host does not need a Rust compiler.

[Compatibility configuration](../tracking/compatibility.json) identifies the BDS
target and pack version. The npm declarations are pinned to server `2.9.0` and
net/admin `1.0.0-beta.1.26.40-stable`; runtime dependencies are separately
`2.9.0` and `1.0.0-beta`. Do not follow npm beta tags automatically.
Declarations are not proof that a candidate BDS binary supports the pack.

The pack requires the Beta APIs experiment. For BDS 1.26.45.1, module-scoped
private-network HTTP configuration must omit optional `force_tls` enforcement:
including `false` causes `TLSOnlyError`. Keep URI, body and concurrency limits,
and secret-backed headers. Recheck this version-specific behavior for each
candidate rather than assuming all beta releases behave identically.

The separate `probe/` pack exercises BDS URI/body/concurrency rejection and
timeouts. Register it only on disposable test worlds, never in the gameplay
world, with explicit `allow_test_probe: true` module configuration. Activation,
stopped backups, experiment approval, secrets and update
fallback belong in the deployment runbook. Removing the tracking pack does not
undo experimental-world metadata.

## Offline-Snapshot LAN Preview

After the deployment gate, set `VIEWER_LAN_IP`, `COLLECTOR_ORIGIN`, `WORLD_ID`
and `MAP_FINGERPRINT`. The collector origin must be its read-listener HTTP URL,
never ingest. With [HTTPS prerequisites](GETTING_STARTED.md#temporary-lan-preview):

```sh
npm run build
npm run serve:lan -- --host "$VIEWER_LAN_IP" \
  --players-origin "$COLLECTOR_ORIGIN" \
  --world-id "$WORLD_ID" \
  --map-fingerprint "$MAP_FINGERPRINT"
```

The fixed-destination proxy relays only the exact player GET/HEAD route, without
client cookies or credentials. It refuses bodies, alternate paths, redirects
and writes. No login is added: anyone able to open the map can read its names
and positions. The Mac preview is a development option, not a hosting requirement.

Update the fingerprint binding when replacing an offline snapshot. Live maps
use world/generation binding so routine terrain repair does not disconnect players.
`?players=off` skips player configuration, requests and polling for one view.
Omit the tracking arguments and restart the preview to disable it for all its
viewers. Neither option changes the world.

## Verification

Unit and synthetic browser checks cover protocol rejection/ordering/expiry,
cadence, failed reads, proxy restrictions, safe labels, selection/follow,
dimensions, stale stationary samples, mobile layouts and zero marker-only
terrain draws. They do not establish retail-client compatibility or hardware
performance.

See [combined acceptance](TERRAIN-ACCEPTANCE.md) for real-client coordinate checks,
independent outages and controlled-pan measurements. `--scope players` isolates
tracking off/on; `--scope combined` compares both feed configurations.
Set the target and output through [operator configuration](CONFIGURATION.md);
no installation-specific address or world size is required.
Sample-to-browser latency depends on synchronized clocks and is not the full
in-game-action delay. Keep live names, coordinates and raw screenshots out of
published reports.

References: [BDS module configuration](https://learn.microsoft.com/en-us/minecraft/creator/documents/bedrockserver/scripting?view=minecraft-bedrock-stable),
[HTTP permissions](https://learn.microsoft.com/en-us/minecraft/creator/documents/update1.26.10?view=minecraft-bedrock-stable),
[experimental worlds](https://learn.microsoft.com/en-us/minecraft/creator/documents/experimentalfeaturestoggle?view=minecraft-bedrock-stable).
