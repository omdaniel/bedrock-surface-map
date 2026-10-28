# Getting Started

## View the Public Demo

Open <https://omdaniel.github.io/bedrock-surface-map/> in a WebGPU-enabled Chrome
or Safari. Drag to pan, wheel/pinch to zoom, select a player to center, or follow
them. Manual navigation cancels follow.

The demo uses original textures and simulated activity. Pause or restart its
60-second loop with the playback controls. With reduced motion enabled it starts
paused. No login, certificate installation, or Minecraft server is needed.

## Run the Demo Locally

This developer path supports Apple Silicon macOS and Linux AMD64/ARM64.
Install Git, Node.js **26.8.1** (also in `.node-version`) and rustup. Native
prerequisites are Python 3, Xcode Command Line Tools and CMake on macOS; on Ubuntu use
`build-essential clang cmake pkg-config libssl-dev libclang-dev`.
Python 3 is needed for archive checks and optional Git hooks. Windows contributors
use WSL2/Linux. The optional [development container](../.devcontainer/Dockerfile)
provides the Linux toolchain and runs the same `./dev setup` after creation.
`./dev setup` installs the Rust 1.92.0 toolchain, WASM target, pinned project-local
tools and npm dependencies. It does not download Minecraft textures.

```sh
git clone https://github.com/omdaniel/bedrock-surface-map.git
cd bedrock-surface-map
./dev doctor
./dev setup
./dev demo
```

`doctor` is read-only: it lists missing tools and fixes, exiting nonzero when
setup is incomplete. `./dev doctor --json` provides the same result as JSON.
Run setup to address its project-tool findings, then rerun doctor. Setup can
take several minutes on a fresh machine. It does not change Git hooks unless
you add `--install-hooks`; `--offline` requires previously cached dependencies.
Use `./dev --help` for commands and supported options.
`npm run bootstrap` is an alias for setup. The optional hooks do not alter global
Git preferences or replace a different repository hook path.

Open the loopback URL printed by Vite; use `./dev demo --port 5181` to select a
different port. This source path creates a synthetic
fixture and does not download Minecraft assets. The public showcase is a
separate reviewed demo packet; `npm run demo:build` creates `.local/demo-dist`.

`./dev` adds its pinned local `wasm-bindgen` to its child processes' `PATH`.
For direct npm build commands below, run this from the checkout root in each
new shell after setup:

```sh
export PATH="$PWD/.sources/tools/wasm-bindgen/0.2.127/bin:$PATH"
```

## Run a Linux Release

See [archive installation](INSTALL.md) for the synthetic and offline-snapshot
paths. The release executable is separate from the source developer workflow.
`bedrock-map serve` serves offline snapshots on loopback only. The separate
[`bedrock-map deploy` commands](DEPLOYMENT.md) prepare an HTTPS live deployment
using a paired operator/image release. Neither path manages a game server.

## Import Your Own Snapshot

Review [third-party asset terms](../THIRD_PARTY.md), then:

```sh
npm run assets
npm run import -- --input /path/to/your-offline-snapshot.mcworld
npm run dev
```

Use a consistent offline export, never a live world directory. Follow the URL
Vite prints, normally <http://127.0.0.1:5173/>. See [import commands and safeguards](IMPORT.md).
This serves derived surfaces, not LevelDB or the original archive.
For custom import paths, display names and viewer bindings, see
[operator configuration](CONFIGURATION.md#viewer-and-read-proxies).

For the small synthetic test map without Minecraft assets:

```sh
npm run fixture
npm run dev
```

Open `http://127.0.0.1:5173/?map=/maps/fixture/manifest.json`.

## Optional Live Integration

[Use an existing itzg BDS server](QUICKSTART-BDS.md) or
[install through Crafty/AMP](PANELS.md). Operator bundles include compiled packs;
the [pack-only contributor path](../CONTRIBUTING.md#work-on-server-packs-only)
requires only Node.js and npm.

[Player tracking](TRACKING.md) and [terrain synchronization](TERRAIN-SYNC.md)
use separate server packs and services. They are explicitly configured; loading
an offline map does not silently connect it to a server. Public Pages is a demo,
not hosting for your live service. The [initial live deployment](DEPLOYMENT.md)
serves the built frontend and read APIs on an always-on Linux host, independent
of this development computer. It uses a shared viewer password by default and
requires an explicit BDS handoff; it does not automate game-server maintenance.

## Temporary LAN Preview

WebGPU needs HTTPS except on loopback. With mkcert installed, build and run:

```sh
npm run build
npm run serve:lan -- --host YOUR_LAN_IP
```

Use `--map` for a custom served manifest and `--port`/`--ca-port` for alternate
listener ports. See [preview configuration](CONFIGURATION.md#viewer-and-read-proxies).

The command prints the HTTPS address and public CA certificate URL. On an iPad,
install the public certificate profile, then enable it under
`Settings > General > About > Certificate Trust Settings`. Never share a CA private
key. This preview requires its host to remain awake; use proper persistent HTTPS
hosting for a production map. GitHub Pages uses trusted HTTPS and needs no custom
certificate.
