# Add a Live Map to an Existing Docker Bedrock Server

This path adds the map beside an existing `itzg/minecraft-bedrock-server`
installation. It uses your existing HTTPS proxy or tunnel and a dedicated
internal Docker network for observations. Your existing Compose project manages
Minecraft; the map has its own project, storage and credentials.

Use an operator bundle that supports `[bds]`, `[gateway]` and `deploy export-bds`;
the snapshot-only download is insufficient. See [release availability and host
requirements](DEPLOYMENT.md). The map host needs supported Linux Docker/Compose,
an existing trusted HTTPS hostname, a consistent offline world export, and access
to the existing BDS files. Clients need an ordinary current Bedrock game and a
WebGPU browser. The integration is BDS-only; Realms does not provide its networking
APIs. Test on a backed-up disposable world before installing on a persistent one.

## 1. Connect the Existing Server

Create a dedicated internal bridge network:

```sh
docker network create --driver bridge --internal bedrock-map-ingest
```

Add it to the existing Bedrock service without removing its current networks.
For a service named `bedrock` using Compose's default network, an override is:

```yaml
services:
  bedrock:
    networks:
      default: {}
      map_ingest: {}
networks:
  map_ingest:
    external: true
    name: bedrock-map-ingest
```

Use your actual service name and retain all existing network declarations,
volumes, game-port mappings and environment settings. Review the merged Compose
configuration and attach the network through your usual server maintenance.
A host-networked BDS container uses the [private LAN alternative](DEPLOYMENT.md)
instead; do not change its game networking solely to install the map.

## 2. Prepare the Map

Unpack the verified operator bundle and its included runtime as instructed in
`INSTALL.txt`. From that directory:

```sh
umask 077
./bedrock-map init --state ./map-data
./bedrock-map assets fetch --state ./map-data --acknowledge-asset-terms
./bedrock-map import --state ./map-data --input /path/to/world.mcworld --name "My World"
```

Create `deployment.toml`, substituting your HTTPS hostname:

```toml
schema_version = 1
project = "bedrock-map"
public_origin = "https://map.example.com"

[features]
terrain = true
players = true

[bds]
network = "bedrock-map-ingest"

[gateway]
mode = "proxy"
bind = "127.0.0.1"
port = 8080
```

```sh
./bedrock-map deploy init --dir ./map-deploy --config ./deployment.toml
./bedrock-map deploy prepare --dir ./map-deploy --snapshot-state ./map-data
./bedrock-map deploy check --dir ./map-deploy
docker compose --project-directory ./map-deploy -f ./map-deploy/compose.yaml up -d
```

Initialization asks for the map viewer password. The collectors publish **no
host ports**; only BDS and the collectors join the ingest network. The viewer
gateway is bound to host loopback. Keep the ingestion network dedicated.

## 3. Use Your Existing HTTPS Proxy

Forward `https://map.example.com` to `http://127.0.0.1:8080` and preserve the
public `Host` header, `map.example.com`. This suits a proxy or Cloudflare Tunnel
agent running on the map host. The browser continues using trusted HTTPS and
same-origin map/player requests; no client certificate installation is needed.

For a proxy running in another container or on another trusted machine, set
`gateway.bind` to an explicit private IPv4 address of the map host and use that
address upstream. A container's `127.0.0.1` refers to itself. Keep this HTTP
origin private and preserve the map's configured authentication. Nginx Proxy
Manager, Traefik and Cloudflare can serve as the existing HTTPS boundary; their
configuration remains yours. Proxy mode needs no additional TCP80/443 forwarding
to the map gateway.

## 4. Export and Install the Server Integration

Use the real BDS data directory mounted at `/data` by itzg, and the exact
`level-name` from that server's `server.properties`:

```sh
BDS_DATA=/path/to/existing/bedrock-data
BDS_WORLD='Bedrock level'
./bedrock-map deploy export-bds --dir ./map-deploy \
  --server-dir "$BDS_DATA" --world "$BDS_WORLD" \
  --output ./bedrock-map-bds.zip --secrets-dir ./bedrock-map-bds-private
```

The ZIP contains compiled packs and configuration merged with the inspected
server files. The separate private directory contains credentials; keep it
outside web roots and Git. The command does not modify BDS. An export without
`--server-dir` contains templates and registration fragments requiring a manual
merge; it does not replace existing world configuration.

During the server's backed-up maintenance window, review/extract the ZIP into
the BDS data directory and copy the separate private configuration alongside it.
Preserve owner-private permissions for `secrets.json`. Enable the required Beta
APIs experiment only with the world owner's approval, then restart through the
existing Compose project. See [handoff details](DEPLOYMENT.md#install-the-bds-handoff)
and [panel instructions](PANELS.md) for file-manager installs.

```sh
./bedrock-map deploy check-bds --dir ./map-deploy \
  --server-dir "$BDS_DATA" --world "$BDS_WORLD"
./bedrock-map deploy check --dir ./map-deploy --running --expect-live
```

`check-bds` verifies installed files and settings without opening LevelDB or
printing credentials. The running check verifies HTTPS and fresh observations;
it can pass with an empty roster. Finally, join with a normal client, move and
make a small surface edit while viewing the map. See [compatibility and
troubleshooting](COMPATIBILITY.md) if a stage is not live.
