# Install a Snapshot Viewer

Bedrock Surface Map release archives target Linux x86-64 and Linux ARM64. Use
only an archive that has passed its matching native Linux smoke check, then
extract it for the matching architecture and verify its SHA-256 entry from the
adjacent `SHA256SUMS` file. A release runs without Node, npm, Rust, Cargo,
Python, Git, Zig, Vite, or a Minecraft server.

```sh
tar -xzf bedrock-surface-map-vVERSION-linux-amd64.tar.gz
cd bedrock-surface-map-vVERSION-linux-amd64
./bedrock-map init --state ./map-data
./bedrock-map demo --state ./map-data
./bedrock-map serve --state ./map-data
```

The server prints a loopback URL such as `http://127.0.0.1:8080/`. The bundled
map is synthetic and requires no network access or Minecraft assets. The
runtime binds only `127.0.0.1` or `::1`; publishing a map to a LAN or Internet
is an operator deployment concern, not an implicit release behavior.

To import a consistent offline `.mcworld` or ZIP snapshot, first acquire the
supported Mojang sample archive explicitly, review the linked terms, then import:

```sh
./bedrock-map assets fetch --state ./map-data --acknowledge-asset-terms
./bedrock-map import --state ./map-data \
  --input /path/to/world.mcworld --name "My World" --replace-active
```

`assets fetch` is the only managed asset download. You can instead supply a
local compatible archive with `import --assets /path/to/assets.zip`; it is
recorded as user-supplied, not as verified Mojang content. Imports accept
archives only, never a live LevelDB directory. A failed import leaves the
previous selected map unchanged.

Use these non-mutating checks to inspect the selected dataset and packaged
resources:

```sh
./bedrock-map status --state ./map-data
./bedrock-map doctor --state ./map-data --json
```

`doctor` cannot prove a browser’s WebGPU capability; open the served URL in a
current WebGPU-capable browser to render a map.
