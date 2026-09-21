# Getting Started

## View the Public Demo

Open <https://omdaniel.github.io/bedrock-surface-map/> in a WebGPU-enabled Chrome
or Safari. Drag to pan, wheel/pinch to zoom, select a player to center, or follow
them. Manual navigation cancels follow.

The demo uses original textures and simulated activity. Pause or restart its
60-second loop with the playback controls. With reduced motion enabled it starts
paused. No login, certificate installation, or Minecraft server is needed.

## Run the Demo Locally

Install Git, Node.js 26.8.1, rustup, and your platform's native build tools
(Xcode Command Line Tools on macOS). Rust 1.92.0 is pinned by rust-toolchain.toml.
Install the pinned tooling without downloading Minecraft textures:

```sh
git clone https://github.com/omdaniel/bedrock-surface-map.git
cd bedrock-surface-map
./dev doctor
./dev setup
./dev demo
```

Open the loopback URL printed by Vite. This source path creates a synthetic
fixture and does not download Minecraft assets. The public showcase is a
separate reviewed demo packet; `npm run demo:build` creates `.local/demo-dist`.

## Run a Linux Release

See [archive installation](INSTALL.md) for the synthetic and offline-snapshot
paths. The release executable is separate from the source developer workflow.
It serves only loopback by default and never manages a game server.

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

[Player tracking](TRACKING.md) and [terrain synchronization](TERRAIN-SYNC.md)
use separate server packs and services. They are explicitly configured; loading
an offline map does not silently connect it to a server. Public Pages is a demo,
not hosting for your live service. Persistent self-hosted deployment can serve
the built frontend and read APIs on an always-on machine, independent of this
development computer.

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
