# Live Player Tracking

## Current Release Gate

The application implements a player roster, compass markers, click-to-center/zoom,
follow and a read-only LAN proxy. It is **not yet connected to Survival**. The
default `viewer-config.json` deliberately disables tracking; a lack of telemetry
is not represented as an empty, healthy server. Production experiment activation
still requires isolated test evidence and explicit owner approval. Updater and
monitoring integration, real-client acceptance and iPad performance acceptance
remain deployment checkpoints in `runproxmox`, not claims made by this build.

The Players button is the people icon at the right of the map toolbar. Select a
gamertag to center and zoom; the target button toggles follow. Manual navigation
cancels follow. Nether/End players remain in the roster without Overworld markers.
The map is an offline terrain snapshot even while players move.

## Application Contract

`surface-tracker` stores one bounded full-roster snapshot in memory. Write requests
go only to the private ingest listener at `/ingest/v1/snapshot`, with the
`x-tracker-token` secret header. The independent read listener exposes
`GET/HEAD /api/v1/worlds/{world_id}/players` and `/healthz`. Responses are `no-store`.
No database, world files, XUIDs, chat, inventories or movement history are used.

Schema 1 is defined by the Rust types and `fixtures/tracking/snapshot.json`.
Ingest is capped at 16 KiB/32 players. Producer epoch, sequence and sample-time
checks reject obsolete data. Coordinates expire after 30 seconds, including in
the collector's memory. A separate high-water mark retains ordering metadata
without player positions. Gamertags are untrusted text, never HTML.

The pack samples every 40 ticks, coalesces roster events, and permits only one
two-second HTTP request at once. Failures retain no backlog and retry fresh data
with a 30-second maximum backoff. Empty-roster heartbeats distinguish idle from
broken. `PopCello8931` is filtered if present. Bedrock yaw is converted with
`(yaw + 180) mod 360` to north-zero clockwise heading.

The browser polls every two seconds while visible. A stationary but old sample
becomes stale at ten seconds and loses markers at thirty, even when HTTP succeeds.
Markers use CSS pixels and the terrain camera's coordinate transform. Ordinary
movement interpolates for 250 ms without prediction; teleport/respawn/dimension
changes snap. Marker-only changes do not request a terrain frame. Follow must
move the camera and therefore does redraw terrain.

## Build and Test

```sh
npm ci
npm run tracking:build
npm run tracking:test
cargo test --locked -p surface-tracker
npm test
rustup target add x86_64-unknown-linux-musl --toolchain 1.92.0
# Requires a clean committed checkout; uses Rust's bundled linker on this Mac.
npm run tracking:bundle
```

The ignored `.local/tracking/bundle` contains the static Linux collector, pack and
per-file SHA-256 manifest tied to the exact application commit. It contains no
credentials or world data. Deployment must verify all hashes and the expected
commit before consuming it. VM100 does not need a Rust compiler.

Candidate declarations are pinned in `package-lock.json`: server `2.9.0`, net/admin
`1.0.0-beta.1.26.40-stable`. Runtime manifest versions are separately `2.9.0` and
`1.0.0-beta`; an npm declaration version is not proof of binary compatibility.
No automatic beta-tag upgrades. See the deployment compatibility record for
actual tested BDS versions.

## LAN Delivery

After the deployment gate, use the existing HTTPS origin and CA:

```sh
npm run build
npm run serve:lan -- --host 192.168.68.110 \
  --players-origin http://192.168.68.114:8110 \
  --world-id bedrock-survival \
  --map-fingerprint d6c03baf7b4bb7a621e85f0acf073abe737bd3789db26505e4268386fee12097
```

This is an operator-configured fixed-destination proxy, not an arbitrary proxy.
Only the exact player GET/HEAD path is relayed, with no client cookies/credentials
forwarded. Request bodies, alternate paths, redirects and ingest are refused.
Neither the world fingerprint nor world ID is a secret. The binding must be
explicitly updated when replacing the terrain snapshot. No login/public hosting
is enabled; a future internet URL would expose player names and current positions.

To independently disable the overlay, omit the three tracking arguments and
restart the preview. This does not alter the world or remove its experiment state.

## Verification Boundaries

Local synthetic checks cover protocol rejection/expiry/restarts, pack cadence and
failed reads, proxy boundaries, safe labels, center/follow/navigation, mobile
layout and stationary terrain draw counts. The full existing renderer suite also
runs. Synthetic players are injected only in browser tests, never at the LAN
endpoint. Synthetic tests do not establish retail-client compatibility, two-player
latency, server tick impact or M4 iPad performance.

References: [BDS module configuration](https://learn.microsoft.com/en-us/minecraft/creator/documents/bedrockserver/scripting?view=minecraft-bedrock-stable),
[HTTP permissions](https://learn.microsoft.com/en-us/minecraft/creator/documents/update1.26.10?view=minecraft-bedrock-stable),
[experimental worlds](https://learn.microsoft.com/en-us/minecraft/creator/documents/experimentalfeaturestoggle?view=minecraft-bedrock-stable).
