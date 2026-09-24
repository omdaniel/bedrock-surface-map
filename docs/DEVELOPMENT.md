# Development and Architecture

The README is the short introduction. This page collects implementation and
maintenance entry points without making the demo visitor read an operator guide.

| Component                       | Responsibility                                                              |
| ------------------------------- | --------------------------------------------------------------------------- |
| surface-core                    | Retained surface fields, lossless codecs, reference shadow calculations     |
| bedrock-map                     | Snapshot import/serving, initial live-deployment preparation and diagnostics |
| bedrock-adapter / surface-cli   | Read-only archive extraction, assets, validation, import and repair exports |
| surface-gpu                     | Rust/WASM renderer, bounded GPU cache, shadows, filtered overviews          |
| surface-tracker / tracking pack | Independent player sampling, collection and browser markers                 |
| surface-sync / terrain pack     | Chunk observations, durable current terrain, incremental delivery           |
| web                             | Worker decoding, navigation, picking, configuration and overlays            |

Live terrain replaces chunks and patches resident height windows, overviews and
picking data. It does not allocate a heightfield for an arbitrarily large world.
The logical map budget is 256 MiB, excluding browser RSS, transient allocations
and graphics-driver overhead. Oversized views request zooming in.

Those limits describe the region-based viewer. The optional
[static LOD path](LOD.md) uses independent detail/summary tiles and a
200,000,000-byte ledger including loading and retirement reservations. Its
preparation commands and current integration boundaries are documented separately.

See [format/rendering](FORMAT.md), [import safeguards](IMPORT.md),
[tracking](TRACKING.md), [terrain synchronization](TERRAIN-SYNC.md),
[acceptance checks](TERRAIN-ACCEPTANCE.md) and [public-demo maintenance](PUBLIC_DEMO.md).
See [operator configuration](CONFIGURATION.md) for addresses, world bindings and
portable verification settings.

## Controls and Appearance

The toolbar provides fit-world, spawn, borders, shadows, lighting and diagnostics.
Sun bearing is clockwise from north: 0 north, 90 east, 180 south, 270 west;
default 330 degrees. Elevation defaults to 45 degrees, shadow strength to 55%.
The wrapping dial supports touch/pointer input and keyboard arrows; Page Up/Down
change 15 degrees, Home points north. Vivid/Original selects color treatment.
Relief strength defaults to 100% and edge width to a quarter block. Settings are
session-local. Idle views stop drawing; player-only movement does not redraw terrain.

See [appearance](APPEARANCE.md) and the
[visual comparison procedure](VISUAL-COMPARISON.md), not a speed benchmark.

## Verify

Use a [bootstrapped checkout and its local tool PATH](GETTING_STARTED.md#run-the-demo-locally).
Local browser checks require installed Google Chrome. Linux CI uses Playwright
Chromium and software Vulkan as configured in the [workflow](../.github/workflows/ci.yml).

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo clippy -p surface-gpu --target wasm32-unknown-unknown --locked -- -D warnings
cargo test --workspace --locked
npm run format:check
npm run config:test
npm run release:test
npm run build
npm run tracking:build
npm run tracking:test
npm run terrain:build
npm run terrain:test
npm run demo:test
npm run lod:test
npm run fixture
npm run lod:fixture
node scripts/terrain-fixture.mjs
npm test
```

CI uses synthetic fixtures and software Vulkan; its public-demo checks use only
the reviewed release packet. Neither requires homelab credentials, raw worlds,
or downloaded Mojang textures. CI results are not hardware performance claims.

For native-browser checks, see `scripts/check-browser.mjs`,
`scripts/check-safari.mjs`, and `scripts/check-demo.mjs`. Safari remote automation
must be explicitly enabled; restore its previous setting after testing.
Local screenshots and raw reports stay ignored, except reviewed public-demo media.

## Maintenance

Use small tested commits on a `codex/` branch and open a PR. Dependency changes
update lockfiles and require native/WASM and browser checks. Parser changes also
require a fresh offline import verification. Keep old immutable dataset references
for rollback; source rollback uses a new revert commit, not rewritten history.
Documentation describes current behavior and limitations. Keep change narratives
and dated measurements in commits or PRs; update the relevant reference when
behavior changes rather than appending a follow-up section.
Git is not the world backup. Operator-specific homelab deployment remains outside
this repository; source changes do not authorize host or game-server changes.
