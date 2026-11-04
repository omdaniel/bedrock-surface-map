# Choose your path

You do not need a Minecraft account or a server to try the map. Installation and
live integration are separate steps; choose the smallest path that fits your goal.

## I want to see what it does

[Open the interactive demo](https://omdaniel.github.io/bedrock-surface-map/demo/).
It contains coastal islands, original demo textures, two fictional players and
scripted surface edits. Nothing connects to a real game server. Use a current
WebGPU-enabled Chrome or Safari; [learn the controls](docs/USER-GUIDE.md).

## I have a world export

[Install the snapshot viewer](docs/INSTALL.md) on Linux AMD64 or ARM64. Download
one native archive, verify its checksum and start the synthetic map. No compiler,
Node.js, Docker or running Minecraft server is needed. Then [prepare an offline
world export](docs/WORLD-EXPORT.md) and import your own Overworld.

On macOS, use the [source setup](docs/GETTING_STARTED.md#run-the-demo-locally).
Windows contributors use WSL2/Linux. Native macOS and Windows release archives
are not supplied.

## I want a live map beside my server

Start with the [live operator download](docs/OPERATOR-INSTALL.md), then follow
the guide matching your setup:

| Your server | Next step |
|---|---|
| Existing `itzg/minecraft-bedrock-server` Docker installation | [Docker quickstart](docs/QUICKSTART-BDS.md) |
| Crafty Controller or AMP | [Panel integration](docs/PANELS.md) |
| BDS and map on separate Linux hosts, or a new HTTPS boundary | [Deployment guide](docs/DEPLOYMENT.md) |

You need administrative access, a consistent offline seed export, an always-on
Linux map host with Docker/Compose, and trusted HTTPS. Live packs require the
Beta APIs experiment. Test a disposable copy before changing a persistent world;
removing a pack does not undo experimental-world status.

[Read compatibility first](docs/COMPATIBILITY.md). Live integration targets
Mojang's official Bedrock Dedicated Server. Realms and PocketMine are unsupported.
Crafty has an executable runtime check; AMP has a documented recipe without
equivalent runtime acceptance. Pages hosts this documentation and a separate
static demo, not your collectors or live map service.

## I want to contribute

[Choose a component in the contribution guide](CONTRIBUTING.md). Website and
server-pack work have Node-only paths. Renderer/importer work uses the pinned
Rust/WASM toolchain. Synthetic fixtures let you develop without private worlds,
Minecraft assets or infrastructure credentials.

## I need help with an installation

Follow [connection checks](docs/COMPATIBILITY.md#troubleshoot-in-order) from the
pack through the collector to the browser. For snapshot issues, use the packaged
[`status` and `doctor` commands](docs/INSTALL.md#check-or-troubleshoot).
Report the app/BDS versions, redacted errors and reproduction steps on
[GitHub Issues](https://github.com/omdaniel/bedrock-surface-map/issues). Do not
attach credentials, raw worlds or player records.
