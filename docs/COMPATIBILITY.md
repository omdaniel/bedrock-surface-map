# Compatibility and Connection Checks

Live integration targets Mojang's official **Bedrock Dedicated Server**, with
the Beta APIs experiment and server-specific module permissions. The viewer and
offline importer do not require a running game server. Live compatibility also
depends on the installed BDS binary, pack manifests and configuration; npm type
definitions alone cannot prove it.

| Component | Declared requirement | Verification scope |
|---|---|---|
| Player pack | `@minecraft/server` runtime `2.9.0`; net/admin runtime `1.0.0-beta` | Exact dependencies are in the shipped pack manifest. |
| Terrain pack | Same runtime dependencies, separate pack/module UUIDs | Its compatibility decision is independent of player tracking. |
| BDS runtime target | `1.26.45.1` | Isolated native AMD64 acceptance covers fresh-world creation, pack loading, authenticated empty-server heartbeats and restart. Other builds require their own acceptance. |
| Crafty Controller | `4.11.0`, pinned image | The manual fixture imports and manages real BDS through its API, installs exports, checks installed readback and queries Bedrock status across restart. File-manager UI interaction is not automated. |
| AMP | Documented file-manager/SFTP recipe | No executable AMP acceptance is claimed. |
| TypeScript declarations | Server `2.9.0`; net/admin `1.0.0-beta.1.26.40-stable` | Build-time definitions pinned in `package-lock.json`; not runtime version strings. |
| Map service host | Native Linux AMD64/ARM64, documented Docker/Compose versions | Native packaging and generated deployments have separate CI gates for both architectures. ARM map support does not imply ARM BDS support. |
| Browser | WebGPU and a secure origin | Current Chrome/Safari are the reference browsers; an unsupported browser shows an explicit error. |
| Realms / PocketMine | Unsupported by the live packs | Realms lacks BDS networking APIs; PocketMine does not execute these behavior packs. |
| Endstone / other BDS loaders | No compatibility guarantee | Retaining BDS underneath a loader is not evidence that its exact release supports these packs. |

Use the release's exact packs and runtime requirements. The checked-in version
target must not be read as a promise that all older/newer clients or BDS binaries
work together. Experimental APIs can change; test the intended stable BDS build
on a disposable world before adoption. Do not switch to Preview to retain a map
feature. Client/server version compatibility remains BDS's responsibility.

## Troubleshoot in Order

1. **Pack installed:** run `deploy check-bds`. Resolve missing pack files,
   registration versions, unsafe credential permissions and module-settings
   failures first. The selected world must match `level-name` in
   `server.properties`. A pack UUID does not name its script configuration folder.
2. **Script running:** inspect the BDS console for load/dependency/permission
   errors. Beta APIs and the three required runtime modules must be available.
   Restart using the existing panel or service after installing the files.
3. **Collector receiving:** run `deploy check --running --expect-live`. Empty
   player heartbeats count as live. For Docker ingestion, BDS and collectors
   must share the dedicated internal network and resolve the generated aliases.
   For LAN ingestion, verify the exact source address and scoped firewall rules.
4. **Browser connected:** open the configured HTTPS hostname, sign in and check
   player and terrain freshness separately. The proxy must preserve the public
   Host header and route the frontend plus enabled read APIs. Browser configuration
   must contain neither ingestion endpoints nor tokens.
5. **Real behavior:** join, move and edit exposed terrain while the map is visible.
   Marker movement and terrain replacement are separate observations. A loaded
   snapshot, green container health or successful synthetic test is insufficient
   proof of actual BDS/player behavior.

The [target record](../tracking/compatibility.json) pins the binary hash and
declares the executable acceptance scope. Empty-server success does not establish
client joins, moving players or loaded terrain scans. Docker/proxy browser CI uses
synthetic producers separately; it does not substitute for real game behavior.

The recorded target omits the optional `force_tls` setting because explicitly
setting it to false can produce `TLSOnlyError` on that build. Do not broaden
global permissions or change world rules to suppress a configuration error.
The generated module-specific HTTP policy specifies only its collector URI.

Share the application version, BDS version, pack versions and redacted check
results when reporting an issue. Never attach tokens, raw worlds, player records
or private configuration. Actual server/client acceptance procedures are in
[TERRAIN-ACCEPTANCE.md](TERRAIN-ACCEPTANCE.md); CI evidence records its synthetic
scope separately.
