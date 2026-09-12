# Bedrock Surface Map

Local, offline Bedrock Overworld surface viewer. Rust extracts a snapshot into
losslessly compressed surface attributes; WebAssembly and wgpu draw the map in
the browser with WGSL. No Vello, image-map tiles, streaming desktop, live server
connection or hosted service.

## Run on this Mac

Prerequisites: Xcode Command Line Tools, rustup, Node.js 26.8.1 (`.node-version`),
Git and a WebGPU-enabled Chrome or Safari. Rust is pinned to 1.92.0. The first
bootstrap installs the WASM target and matching wasm-bindgen CLI, checks the
local secret-scanning hooks, downloads the pinned Mojang samples and builds WASM.
Review the asset terms in [THIRD_PARTY.md](THIRD_PARTY.md).

```sh
cd /Users/macbookpro/oneoff/bedrock-surface-map
npm run bootstrap
npm run import -- --input /Users/macbookpro/Downloads/Bedrock-Survival-2026-09-11.mcworld
npm run dev
```

Open http://127.0.0.1:5173/. Vite stays on loopback, choosing the next free port
if 5173 is occupied; use the URL printed by Vite. Only the web directory and
derived map assets are served. Neither the source archive nor extracted LevelDB
directory is web-accessible. No Proxmox, Minecraft, Hermes or VDI configuration
is changed by any command in this repository.

Without a private world or Mojang download:

```sh
npm ci
npm run wasm
npm run fixture
npm run dev
```

Open `http://127.0.0.1:5173/?map=/maps/fixture/manifest.json` for the synthetic map.
This route and the real map use exactly the same codec, worker and renderer.

## Interaction

Drag to pan; wheel or pinch to zoom. The toolbar provides fit-world, spawn,
block borders, shadows, lighting/color settings and diagnostics. Sun elevation
defaults to 45 degrees from the northwest and is adjustable from 15 to 75 degrees.
Shadow strength defaults to 55%; Vivid/Original selects the color treatment.
These settings are session-local. Hover inspects coordinates, top height
and material. The camera stays north-up. Redraws stop while the view is idle;
performance sampling animates a short pan only when explicitly requested.
WebGPU is required: unsupported browsers and lost devices produce an explicit
message, not a silent renderer substitution. Retry after device loss reloads
the snapshot and recreates GPU resources.

## Layout

| Component | Ownership |
| --- | --- |
| `surface-core` | Surface fields, versioned codec, pure Rust Zstd decode, CPU shadow oracle |
| `bedrock-adapter` | Pinned Bedrock parser; read-only extraction and material-state catalog |
| `surface-cli` | Archive safeguards, import, atlas, atomic publication, inspect and benchmark |
| `surface-gpu` | WASM ABI, GPU residency, compute shadows/overviews, WGSL drawing |
| `web/src` | Worker transport, bounded visible-region cache, navigation, picking, diagnostics |

See [import safety and commands](docs/IMPORT.md), [format and rendering](docs/FORMAT.md),
[verification results](docs/VERIFICATION.md) and the
[uNmINeD/BedrockMap visual comparison](docs/VISUAL-COMPARISON.md).
The [appearance follow-up](docs/APPEARANCE.md) explains fractional-block shadows
and how to reproduce the matched beach comparison.

## Verify

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo clippy -p surface-gpu --target wasm32-unknown-unknown --locked -- -D warnings
cargo test --workspace --locked
npm run format:check
npm run build
npm run fixture
npm test
```

Native GPU tests require a Metal or Vulkan adapter. Linux CI installs Mesa's
software Vulkan driver and uses synthetic fixtures only. CI compiles WASM and
runs browser interaction/error tests; it neither downloads Mojang assets nor
uploads compiled artifacts or private-world screenshots. CI is not a hardware
performance result or a real-world parser compatibility claim.

Hardware verification with the dev server already running on port 5173:

```sh
node scripts/check-browser.mjs
# Safari: temporarily enable Settings > Developer > Allow remote automation.
# Start /usr/bin/safaridriver -p 4444 in another terminal, then:
node scripts/check-safari.mjs
# Stop safaridriver and turn remote automation off again after the test.
cargo build --release --locked -p surface-cli
node scripts/verify-import.mjs /Users/macbookpro/Downloads/Bedrock-Survival-2026-09-11.mcworld
```

Reports/screenshots are under ignored `.local/verification`; synthetic screenshots
are under ignored `test-results`. Commit summaries, not private artifacts.

## Boundaries and Maintenance

- One snapshot, Overworld, top-surface representation. Not a replacement for a
  full-world backup, arbitrary 3D Minecraft rendering, or multiplayer tracking.
- Exact compression applies to retained fields, not the underground world.
- Biome colors approximate vanilla palettes. Complex stairs/fences/glass,
  canopy cutouts and multiple translucent layers have explicit approximations.
- The 256 MiB resident map budget covers logical GPU buffers/textures and CPU
  picking arrays, not browser RSS, WASM heap, driver overhead or transient decode
  allocations. The real 64-region snapshot fits. Very large visible areas may
  request zooming in; paging compact overview-only regions is a future extension.
- Shadows use the complete snapshot heightfield. A new manifest is adopted on
  reload, rebuilding every affected cache, not by a live change-feed service.
- Update dependencies in an isolated `codex/` branch, regenerate lockfiles,
  rerun synthetic CI and both real-browser checks. Parser updates require a
  fresh real-world import/hash/sample verification. Codec changes need a format
  version bump or a compatible reader; never reinterpret old objects silently.
- New outputs are immutable/content-hashed; preserve an old manifest and its
  referenced objects for data rollback. Source rollback is a new `git revert`
  commit followed by the matching build. Git is not the world backup.
- Future homelab deployment manifests belong in `runproxmox`, not here. Static
  manifest/asset URLs permit CDN hosting later, after access and licensing review.
