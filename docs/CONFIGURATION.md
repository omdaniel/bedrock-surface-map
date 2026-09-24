# Operator Configuration

Installation addresses, world identity and account policy belong in deployment
configuration, not application source. Examples use fixtures or loopback; no tool
automatically connects to a homelab.

The separate [live deployment](DEPLOYMENT.md)
uses `deployment.toml` for a dedicated HTTPS hostname, private ingest addresses,
feed selection and viewer access. It does not reuse the snapshot server's
`config.toml`; initialization alone does not prepare or start services.

## Verification Tools

Copy [the example](../examples/verification.json) to an ignored location such as
`.local/verification-config.json`, then set your viewer URL and report directory.

```sh
export MAP_VERIFY_CONFIG="$PWD/.local/verification-config.json"
node scripts/check-browser.mjs
node scripts/check-live-tracking.mjs
node scripts/check-tracking-performance.mjs --scope combined --browser chrome
node scripts/check-tracking-outage.mjs --service terrain
```

The tools accept `--config`, `--url`, `--output`, `--webdriver` and
`--expected-regions`. Precedence is CLI, environment, JSON, then loopback defaults.
Environment overrides are `MAP_URL`, `MAP_EVIDENCE`, `MAP_WEBDRIVER_URL` and
`MAP_EXPECTED_REGIONS`. Relative paths resolve against the working directory.
URLs with credentials are rejected. Non-loopback viewers require HTTPS; Safari's
WebDriver remains loopback-only and requires explicit automation permission.

Region count is optional: normal readiness checks use loaded visible data, not a
particular world size. Appearance checks use spawn unless JSON supplies `view`
or `detailView` objects with `x`, `z` and `scale` (pixels per block). Comparison
captures accept `areas`, an array of `{name, x, z, blocks}` objects. Match reference
images to those configured bounds. Keep live screenshots and reports private.
Place each reference at `unmined-<area-name>.png` in the configured output folder.

`check-terrain-real.mjs` additionally requires `--state`, `--world-id` and
`--generation` for a derived store. `verify-import.mjs` requires `--input` and
`--map-dir`, with optional `--assets`. Both accept `--cli` for the native binary;
these fields can also live in the JSON file. Neither accepts a live world database.
Outage observers never stop services; use a separately authorized recovery plan.

Synthetic Playwright tests run on loopback. Set `SURFACE_TEST_PORT` to avoid an
occupied development port. Proxy integration tests allocate temporary local ports
and never require Minecraft or homelab credentials.

## Viewer and Read Proxies

For the Vite preview or an operator-managed static web server, serve an
operator-owned `viewer-config.json` beside the built site. Its optional
`map` selects the offline manifest, relative to the application's base path;
the default is `maps/world/manifest.json`. An explicit `?map=` overrides it.
Live `terrain` and `players` bindings follow their respective guides.

For the optional [static LOD viewer](LOD.md), `lod_url` selects a prepared
`lod.json` relative to the application base path. `memory_budget_bytes` can
reduce its default 200,000,000-byte managed-memory ceiling; it cannot raise it.
These options do not automatically convert a dataset or enable live LOD updates.
The development server accepts `SURFACE_MAP` for the same offline selection.

The [packaged snapshot server](INSTALL.md) instead generates `viewer-config.json`
from its selected offline dataset. Its state-directory `config.toml` configures
only `server.bind` (loopback) and `server.base_path`; it does not accept live-feed
bindings or proxy settings.

The importer defaults to `web/public/maps/world`; `--output` selects another
directory and `--name` sets its display name. Import and serving locations must
agree. `?terrain=off` uses the configured offline map independently of players.

The temporary LAN preview accepts `--map`, `--players-origin`, `--terrain-origin`,
`--world-id`, `--generation`, `--map-fingerprint`, `--host`, `--port` and `--ca-port`.
Read origins allow operator-selected ports on RFC1918 or loopback IPv4 HTTP(S)
addresses.
Use read listeners, not ingestion. Proxy destinations are fixed at startup;
requests cannot select another host, path, query or write operation. Redirects,
credentials and client cookies are not forwarded. DNS proxy targets are not
supported; this prevents DNS rebinding outside the private-address boundary.

The native collector listeners serve plain HTTP. An HTTPS read origin requires
separate TLS termination and a certificate valid for the configured IP address
and trusted by the Node proxy. This is independent of the browser-facing HTTPS
certificate; enabling HTTPS on the preview does not add TLS to its upstreams.

## Server Services and Packs

`surface-sync` requires `--world`/`TERRAIN_WORLD_ID` and
`--generation`/`TERRAIN_GENERATION`. Bind listeners with `TERRAIN_READ_BIND` and
`TERRAIN_INGEST_BIND`; `serve` requires `--token-file`/`TERRAIN_TOKEN_FILE`.
The player collector uses `TRACKER_WORLD_ID`,
`TRACKER_READ_BIND`, `TRACKER_INGEST_BIND` and `TRACKER_TOKEN_FILE`.
Defaults bind only loopback. The reference Compose stack keeps read listeners
inside its application bridge and proxies them through authenticated HTTPS;
private ingest publishing is restricted to the declared BDS source. Do not expose
either collector directly to the Internet.

BDS module variables supply `world_id`, `collector_url` for player tracking, and
`world_id`, `generation`, `terrain_url` for terrain. Endpoint ports are configurable;
the fixed ingest routes, secret-backed headers and module HTTP permissions remain
required. Tracking's optional `excluded_players` is an array of gamertags, matched
case-insensitively. Its default is empty; configure service-account exclusions
explicitly. The collector does not impose a particular account-name policy.

Diagnostic packs additionally require `allow_test_probe: true` in their own module
variables. Their targets and world identity are explicit configuration, not a
particular Docker subnet or container name. Register them only on disposable
worlds. Run candidate checks before deployment; application builds do not modify
production configuration, worlds, secrets or game services.

Package the preview's imported modules together: `serve-lan.mjs`, `map-proxy.mjs`,
`tracker-proxy.mjs` and `private-origin.mjs`. Deployment recipes own these file
lists and the configured map path, read ports, excluded accounts and probe opt-in.
