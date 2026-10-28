# Install a Snapshot Viewer

Bedrock Surface Map release archives target Linux x86-64 and Linux ARM64. Use
only an archive that has passed its matching native Linux smoke check. Verify its
SHA-256 entry from the adjacent `SHA256SUMS` file before extracting it for the
matching architecture. A release runs without Node, npm, Rust, Cargo,
Python, Git, Zig, Vite, or a Minecraft server.

## Download and Run

[Download a release](https://github.com/omdaniel/bedrock-surface-map/releases/latest)
for **Linux AMD64** (Intel/AMD x86-64) or **Linux ARM64**. The release includes
checksums, source and native test evidence. macOS users can use the
[public demo](https://omdaniel.github.io/bedrock-surface-map/) or the
[source development path](GETTING_STARTED.md#run-the-demo-locally).

On Linux, these commands select your architecture, download into a dedicated
directory and verify the archive before extracting it. They need `curl`, `tar`
and `sha256sum`; do not run them with `sudo`.

```sh
set -eu
version=v0.1.1
case "$(uname -s):$(uname -m)" in
  Linux:x86_64) arch=amd64 ;;
  Linux:aarch64|Linux:arm64) arch=arm64 ;;
  *) echo "Use a supported Linux host or the source development guide."; exit 1 ;;
esac
archive="bedrock-surface-map-$version-linux-$arch.tar.gz"
base="https://github.com/omdaniel/bedrock-surface-map/releases/download/$version"
mkdir "bedrock-map-$version"
cd "bedrock-map-$version"
curl --fail --location --remote-name "$base/$archive"
curl --fail --location --remote-name "$base/SHA256SUMS"
sha256sum --check --ignore-missing SHA256SUMS && tar -xzf "$archive"
cd "bedrock-surface-map-$version-linux-$arch"
./bedrock-map init --state ./map-data
./bedrock-map demo --state ./map-data
./bedrock-map serve --state ./map-data
```

The server prints a loopback URL such as `http://127.0.0.1:8080/`. The bundled
map is synthetic and requires no network access or Minecraft assets. The
runtime binds only `127.0.0.1` or `::1`; publishing a map to a LAN or Internet
is an operator deployment concern, not an implicit release behavior.

Keep the terminal running while viewing the map; Ctrl-C stops the server without
deleting its state. On a headless Linux host, forward its loopback listener from
your computer with `ssh -L 8080:127.0.0.1:8080 USER@HOST`, then open
`http://127.0.0.1:8080/` locally. This keeps WebGPU on a trusted loopback origin
without exposing a public listener or installing a certificate.

`bedrock-map serve` selects an immutable offline snapshot. It does not configure
live player or terrain feeds, install packs, or manage background services.
Although the archive includes collector binaries and packs, live deployment
uses the separate [initial live deployment](DEPLOYMENT.md), paired image/operator
release and explicit BDS handoff. The [player](TRACKING-REFERENCE.md) and
[terrain](TERRAIN-SYNC.md) guides describe the service interfaces for other operator
integrations. The snapshot command is not a replacement for that setup.
Live installation requires the operator bundle and image lock from the same
release. CI candidate artifacts are for release verification, not a simpler
install path. Follow the documentation bundled with your selected version.

## Import Your World

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

## Check or Troubleshoot

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
