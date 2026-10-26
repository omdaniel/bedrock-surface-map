# Contributing

Use [source setup](docs/GETTING_STARTED.md#run-the-demo-locally) to install the
pinned tools and open a synthetic map. No Minecraft account, private world or
running server is needed for ordinary development.

```sh
./dev --help
./dev check
./dev test -- tests/dial.spec.ts
```

Before a pull request, run `./dev check --profile full`. It is the source/demo
suite used by CI; native release packaging has separate architecture-specific
checks. See [development](docs/DEVELOPMENT.md#verify) for focused iteration and
[architecture](docs/DEVELOPMENT.md) for component ownership.

Keep changes focused. Include the user-visible behavior, relevant test results
and any remaining limitations in the PR. Update affected documentation to describe
current behavior; leave change history in commits and the PR. Keep dependency
lockfiles with dependency changes. Source is [AGPL-3.0-only](LICENSE).
Keep generated maps, downloaded Mojang assets, release archives and private data
outside Git. Use a `codex/` branch for substantive work.

For bugs, include the release tag or commit, browser/version, OS, steps, expected
result and actual result. Try the public demo or a synthetic fixture when possible.
Share only redacted errors or screenshots. Never upload credentials, raw worlds,
player records or private server configuration to an issue. A small synthetic
reproduction is preferable to someone else's private world.
