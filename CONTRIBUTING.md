# Contributing

## Choose a Component

| Change | Tools and starting point | Focused local checks |
|---|---|---|
| Documentation and welcome website | Node.js; [website guide](docs/WEBSITE.md) | `npm --prefix website test` and `npm --prefix website run build` |
| Behavior packs | Node.js; [pack-only setup](#work-on-server-packs-only) | Build and test the affected pack |
| Browser UI, rendering, imports or collectors | Full source setup below; [component ownership](docs/DEVELOPMENT.md) | `./dev check` and relevant browser/native tests |
| Deployment generation and packaging | Source setup plus [release CI](docs/CI.md) | Relevant deployment tests; architecture-specific CI |

Synthetic fixtures need no Minecraft account, private world or infrastructure
credentials. Contributions and bug reports use
[GitHub](https://github.com/omdaniel/bedrock-surface-map); GitHub Pages hosts the
documentation. Site changes edit the canonical Markdown rather than generated HTML.

## Work on the Application

Use [source setup](docs/GETTING_STARTED.md#run-the-demo-locally) to install the
pinned tools and open a synthetic map. No Minecraft account, private world or
running server is needed for ordinary development.

```sh
./dev --help
./dev check
./dev test -- tests/dial.spec.ts
```

Before a pull request, run checks relevant to the changed components and state
which checks you ran. Application changes use `./dev check`; the complete
`./dev check --profile full` source/demo suite runs in CI and can be run locally
before cross-component changes. Website-only and pack-only contributors do not
need to install Rust just to run unrelated checks. Native release packaging has
separate architecture-specific checks. See [development](docs/DEVELOPMENT.md#verify) for focused iteration and
[architecture](docs/DEVELOPMENT.md) for component ownership.

Keep changes focused. Include the user-visible behavior, relevant test results
and any remaining limitations in the PR. Update affected documentation to describe
current behavior; leave change history in commits and the PR. Keep dependency
lockfiles with dependency changes. Source is [AGPL-3.0-only](LICENSE).
Keep generated maps, downloaded Mojang assets, release archives and private data
outside Git. Use a `codex/` branch for substantive work.

## Work on Server Packs Only

For pack changes, install the pinned Node.js version from `.node-version`, then
run the commands below from the checkout root. Rust, WebAssembly and the renderer
build are not needed for this path.

```sh
npm ci
npm run tracking:build
npm run tracking:test
npm run terrain:build
npm run terrain:test
```

Compiled packs are in `.local/tracking/pack` and `.local/terrain/pack`; diagnostic
probe packs are separate outputs. These commands compile and test code without
installing anything in a server or enabling experiments. For an installed
release, use [the server integration exporter](docs/PANELS.md#prepare-the-files)
instead of rebuilding packs. Keep the collectors and packs on the same release;
see [runtime compatibility and acceptance](docs/COMPATIBILITY.md).

For bugs, include the release tag or commit, browser/version, OS, steps, expected
result and actual result. Try the public demo or a synthetic fixture when possible.
Share only redacted errors or screenshots. Never upload credentials, raw worlds,
player records or private server configuration to an issue. A small synthetic
reproduction is preferable to someone else's private world.
