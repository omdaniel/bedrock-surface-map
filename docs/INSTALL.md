# Install a Snapshot Viewer

Bedrock Surface Map release archives target Linux x86-64 and Linux ARM64. Use
only an archive that has passed its matching native Linux smoke check. Verify its
SHA-256 entry from the adjacent `SHA256SUMS` file before extracting it for the
matching architecture. A release runs without Node, npm, Rust, Cargo,
Python, Git, Zig, Vite, or a Minecraft server.

Successful [GitHub Actions runs](https://github.com/omdaniel/bedrock-surface-map/actions/workflows/ci.yml)
provide an AMD64 candidate in `native-amd64-<commit>`; download and unpack that
artifact to obtain the archive, checksums and test evidence. A CI artifact is not
a tagged [release](https://github.com/omdaniel/bedrock-surface-map/releases).
Versioned publication is a separate [release CI](CI.md) step that requires both
native Linux targets to pass. Replace `VERSION` below with the archive's version.

```sh
sha256sum --check --ignore-missing SHA256SUMS
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

`bedrock-map serve` selects an immutable offline snapshot. It does not configure
live player or terrain feeds, install packs, or manage background services.
Although the archive includes collector binaries and packs, live deployment
requires the separate [player](TRACKING-REFERENCE.md) and
[terrain](TERRAIN-SYNC.md) integration plus an operator-configured web server
and read-only proxies. The snapshot command is not a replacement for that setup.

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

`doctor` exits with status 3 when a required check fails. To check a running
server too, add `--url http://127.0.0.1:8080/` (or its configured loopback
mount path). It refuses non-loopback destinations and does not follow redirects.
The selected snapshot and packaged resources are checked for integrity before
`serve` reports readiness. Imports keep temporary world data private; after an
unclean power loss, inspect `map-data/staging/` and remove only abandoned
operation directories after confirming no import is running.

`doctor` cannot prove a browser’s WebGPU capability; open the served URL in a
current WebGPU-capable browser to render a map.
