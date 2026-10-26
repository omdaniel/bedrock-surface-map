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
The logical map budget is 256 MiB, with 32 MiB reserved for working allocations;
it is not a browser/driver RSS guarantee. One view-wide sample spacing selects
exact blocks, 2×2 summaries or 4×4 summaries. Wider views reduce detail without
moving the camera. Views exceeding even the 4×4 representation require zooming in.

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
./dev check                         # formatting, types, JS tests and core Rust tests
./dev test -- tests/dial.spec.ts     # one browser test file, with its fixtures prepared
./dev check --profile full          # the same complete source/demo check used by CI
```

`npm test -- tests/dial.spec.ts` is equivalent to `./dev test -- ...`;
`npm run verify` is equivalent to the full check. Browser tests build WASM and
prepare the basic, coastline and live-terrain fixtures automatically. `./dev
fixtures` prepares those datasets without opening a browser. For repeated browser
iterations after preparation, `npx --no-install playwright test tests/dial.spec.ts`
reuses them. Set `SURFACE_TEST_PORT` if the default test port 5173 is occupied;
do not point tests at a running production viewer.

The full check also builds and tests the reviewed public demo under its Pages
subpath, and audits its output. It can download that hash-pinned public dataset.
It does not require Zig or the cross-compilation tools used for release packaging.
Use `./dev package --help` and [release CI](CI.md) only when building releases.

CI uses synthetic fixtures and software Vulkan; its public-demo checks use only
the reviewed release packet. Neither requires homelab credentials, raw worlds,
or downloaded Mojang textures. CI results are not hardware performance claims.

For native-browser checks, see `scripts/check-browser.mjs`,
`scripts/check-safari.mjs`, and `scripts/check-demo.mjs`. Safari remote automation
must be explicitly enabled; restore its previous setting after testing.
Local screenshots and raw reports stay ignored, except reviewed public-demo media.

## Maintenance

See [contributing](../CONTRIBUTING.md) for the short change and bug-report workflow.

Use small tested commits on a `codex/` branch and open a PR. Dependency changes
update lockfiles and require native/WASM and browser checks. Parser changes also
require a fresh offline import verification. Keep old immutable dataset references
for rollback; source rollback uses a new revert commit, not rewritten history.
Documentation describes current behavior and limitations. Keep change narratives
and dated measurements in commits or PRs; update the relevant reference when
behavior changes rather than appending a follow-up section.
Git is not the world backup. Operator-specific homelab deployment remains outside
this repository; source changes do not authorize host or game-server changes.
