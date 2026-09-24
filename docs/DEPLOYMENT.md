# Initial Live Deployment

This reference runs one Overworld map at a dedicated HTTPS hostname, with
terrain updates, player positions, or both. Bedrock Dedicated Server (BDS)
remains independently managed. Use a restored/disposable world before adopting
the packs on a persistent world. Public image publication and actual-BDS
acceptance are separate from passing synthetic CI.

## Requirements

- Native Linux AMD64 or ARM64, an Ubuntu 24.04-class host, rootful Docker Engine
  28.0.4 or newer and Compose 2.38.2 or newer. Rootless Docker and user-namespace
  remapping are outside this reference topology.
- A non-root operator with a non-root primary group and Docker access. Docker
  access is administrative privilege; do not give it to BDS or these containers.
- A local persistent filesystem and an exact, checksum-verified operator bundle
  with its adjacent `deployment-release.json`. That file pairs published runtime
  and gateway image digests with the bundle's source/common-resource identity.
  A snapshot-only archive or an unpublished OCI candidate is not this bundle.
- A consistent offline BDS world archive and explicitly obtained compatible
  texture assets. Never point the importer at a running world database.
- A dedicated DNS hostname whose A record reaches this map host, incoming TCP
  80/443 (including any NAT forwarding), and persistent Caddy certificate storage.
  Remove incorrect AAAA records rather than directing IPv6 clients elsewhere.
- Explicit private IPv4 addresses for the map host and BDS source on a trusted
  LAN/VPN, with Docker-aware source filtering. Private HTTP is not encryption.

The gateway owns ports 80/443 and obtains public certificates. Reverse-proxy
integration, DNS-challenge plugins, internal CAs and non-root URL prefixes are
not additional production topologies in this reference. An ARM map host does
not imply ARM BDS support. No compiler, Node or Minecraft installation is needed
on the map host's runtime path.

The hostname must be reliably reachable from both the map host and LAN browsers.
A router with missing or unreliable NAT loopback can cause failed connections or
intermittent live-feed stalls even when the initial page loads. Configure local/split
DNS to resolve the hostname to the map host's private address for affected LAN
clients; keep public DNS directed at the public address for outside clients.
Compare the two network paths before attributing request timeouts to the collectors
or renderer. Keep the public hostname and certificate checks on both paths; do not
disable TLS verification to work around local routing. Verify authenticated access
and live-feed delivery from inside and outside the LAN separately.

## Prepare

Extract the verified `operator-linux-amd64` or `operator-linux-arm64` bundle into
its own directory. Follow `INSTALL.txt` to unpack the included, unchanged native
runtime archive beside `deployment-release.json`, then run `bedrock-map` there.
Preserve its adjacent resources and release lock.
Use an ordinary private operator directory, not a directory shared with BDS.

```sh
umask 077
./bedrock-map init --state ./map-data
./bedrock-map assets fetch --state ./map-data --acknowledge-asset-terms
./bedrock-map import --state ./map-data --input /path/to/world.mcworld --name "My World"
```

Alternatively supply a compatible local asset ZIP with `import --assets`; use
that same archive for `deploy prepare --assets`. The bundled synthetic demo is
not a substitute for an imported Bedrock seed. See [snapshot installation](INSTALL.md).

Create `deployment.toml` with your actual addresses and hostname:

```toml
schema_version = 1
project = "family-map"
public_origin = "https://map.example.com"
ingest_bind = "10.20.0.10"
bds_source_ipv4 = "10.20.0.20"

[features]
terrain = true
players = true

[viewer]
access = "password"
username = "map"
```

Both feeds default to disabled; select at least one. Disabled services, secrets,
routes and viewer bindings are omitted. Ingest ports default to 18082 (terrain)
and 18081 (players); `[ports]` can explicitly change them. The public origin must
be lowercase HTTPS with no path, port, trailing slash or credentials.

Optional `[terrain_pack]` settings control the generated BDS module variables:
`view_distance` is the chunk discovery radius (4-16, default 16), and
`scan_budget_ms` is the cooperative per-tick time budget (1-4, default 1).
Select a radius appropriate to the existing BDS view distance. Increase the budget
only after measuring game responsiveness and scan freshness on the test world;
the pack's query cap remains unchanged. A fresh HTTP heartbeat does not guarantee
timely terrain scans: `scan-delayed` remains degraded until coverage catches up.
Loaded chunks become eligible for background rescanning 30 seconds after their
last scan, leaving time for discovery and extraction before the 60-second coverage
target. Unloaded chunks retain their last-known published terrain but are excluded
from active scan coverage until loaded again. These intervals are not latency
guarantees; the configured per-tick limits still take priority.
Choose these settings before initialization; 2A does not update an active handoff.

```sh
./bedrock-map deploy init --dir ./map-deploy --config ./deployment.toml
./bedrock-map deploy prepare --dir ./map-deploy --snapshot-state ./map-data
./bedrock-map deploy check --dir ./map-deploy
```

Initialization prompts for a 12-72-byte viewer password, without echo. Automation
can supply `--viewer-password-file` pointing to an operator-owned mode-0600 file;
never put a password in a command argument. Repeating identical initialization
preserves identities and credentials. Changed settings or missing secrets fail;
the command is not a credential-rotation or migration tool.

Preparation validates the snapshot and assets, builds a full material library,
seeds a new terrain store, synchronizes final file contents/metadata and all staged
directories child-first, and selects the completed directory atomically. It does
not start services or modify BDS. Identical retries validate without reseeding;
changed snapshots or active stores refuse. After an interrupted preparation,
inspect `map-deploy/work/prepare-*` and confirm the process has stopped before
removing only its abandoned scratch. Never delete `prepared/` to bypass a refusal.

`E_PREPARE_SYNC` means synchronization of the staged tree failed before publication;
no new `prepared/` is selected. Investigate the filesystem before retrying.

`E_PREPARED_DURABILITY` means the complete `prepared/` tree is published, but the
parent-directory durability check failed. The command exits nonzero without
removing that tree. Preserve it, investigate the filesystem, and run `deploy check`
before starting services; do not delete or reseed it as failed temporary output.

## Start and Check

Review and apply the generated [Docker-aware firewall policy](../deploy/FIREWALL.md)
as the host administrator **before** publishing the ingest listeners. It must
restrict those private ports to the configured BDS source. Do not forward ingest
ports at the router. Neither `init`, `prepare`, `check` nor Compose applies rules.

```sh
docker compose --project-directory ./map-deploy -f ./map-deploy/compose.yaml config --quiet
docker compose --project-directory ./map-deploy -f ./map-deploy/compose.yaml up -d
./bedrock-map deploy check --dir ./map-deploy --running
```

Caddy needs working DNS and incoming TCP80/443 to issue its certificate. Complete
any router forwarding only after the hostname and intended service are ready.
The running check asks for the viewer password again; its stored bcrypt hash
cannot recover it. Open the configured HTTPS URL and sign in with the shared
viewer account. No browser certificate installation is needed with a valid public
certificate. The initial snapshot works before BDS reports any observations.

`check` is read-only: no service starts, pulls, imports, firewall changes or world
access. Local preflight validates immutable files, private ownership, image locks
and Compose. It checks terrain-store file metadata without reopening live SQLite.
The running check inspects only this project's images, mounts, ports, isolation
and health; HTTPS checks the actual seed/binding and live store identity.

Its JSON output (`--json`) distinguishes `prepared`, `serving_awaiting_bds`,
`live_verified` and `failed`. Starting feeds may await installation; stale,
unavailable, disabled or degraded enabled feeds fail. `--expect-live` additionally
requires fresh observations from every enabled feed. Empty roster heartbeats count
as live; nobody needs to be online. Required check failures exit 3; invalid inputs
exit 2. Remote firewall vantages and actual browser/game acceptance remain explicit
separate checks, never inferred from localhost success.

## Install the BDS Handoff

`map-deploy/prepared/bds-handoff/` is **private** and contains ingest credentials.
Transfer it securely to the BDS administrator; never place it under a web root.
Its pack files and runtime requirements belong to the same operator release.

1. Identify the intended BDS installation and world. Confirm that the imported
   snapshot belongs to that world; a friendly name cannot prove this association.
2. Make and verify a consistent backup through BDS's own guarded maintenance.
   Install on a restored/disposable copy first, with independent telemetry secrets
   and no public game tunnel. Check the actual binary against each module's
   generated `runtime-requirements.json` and supplied pack manifest. These declare
   runtime dependency versions, not npm declaration-package versions.
3. Obtain explicit approval for Beta APIs on the intended world. Removing packs
   does not undo experimental-world metadata. Retain the pre-experiment recovery
   copy independently; never restore it automatically over subsequent progress.
4. While that test BDS is stopped, copy each reviewed `packs/<pack-uuid>` directory
   into its `behavior_packs` directory. Merge this handoff's
   `world-pack-entries.json` into the selected world's `world_behavior_packs.json`.
   Preserve every unrelated entry; do not replace the entire list.
5. Merge `variables.json`, `secrets.json` and `permissions.json` by key into BDS
   `config/<script-module-uuid>/`. The script UUID is not the pack UUID. Inspect
   `runtime-requirements.json` for the exact dependencies. Do not install that
   informational file as BDS configuration, overwrite unrelated module settings,
   or enable networking in default permissions. The generated HTTP policy permits
   only the exact collector URI with bounded body/concurrency limits.
6. Restart through BDS's maintenance procedure. Verify startup and ordinary client
   joins, then run `./bedrock-map deploy check --dir ./map-deploy --running --expect-live`.
   Verify actual player movement and a placed/removed block in the browser.

The checked-in compatibility target is not a guarantee for every BDS release.
The `force_tls` setting has version-dependent behavior; the handoff omits it for
the recorded target. Diagnostic probe packs are not part of the ordinary handoff.
Only adopt the persistent world after the isolated checks and its own backup/idle
approval. This workflow does not install, upgrade or restart BDS for you.

## Stop, Preserve and Remove

Use `docker compose ... stop` with the same project-directory/file arguments.
`start` restarts the same containers without reseeding. Terrain and player services
can stop independently. The browser preserves last-known terrain, expires stale
player markers, and reports freshness separately. `?terrain=off` selects the retained
snapshot; `?players=off` disables markers for that view.

For a manual preservation copy, stop **all writers** before copying the deployment:

```sh
docker compose --project-directory ./map-deploy -f ./map-deploy/compose.yaml stop
umask 077
tar -czf /path/to/private-backup/map-deploy.tar.gz ./map-deploy
tar -tzf /path/to/private-backup/map-deploy.tar.gz >/dev/null
docker compose --project-directory ./map-deploy -f ./map-deploy/compose.yaml start
```

Choose a private backup directory, use a fresh filename, check every command's exit
status and verify the copy independently. Include configuration, release lock,
secrets, prepared public/handoff files, terrain SQLite/objects and Caddy storage.
Do not copy a live SQLite database, use `down -v` as routine maintenance, or call
this a BDS world backup. Scheduled backup/restore, upgrades, rotation and routine
reconciliation are separate lifecycle work, not automated by these commands.

To remove the integration, stop the map stack and use BDS's guarded idle procedure
to remove only these packs' world registrations and reviewed module settings.
Removing telemetry must not reset the world or its experimental status. Remove
only this deployment's firewall rules and optional router forwards after verifying
their ownership. Keep recovery data until its removal is separately approved.
