# Contributing

Development requires Git, Node `26.8.1`, Rust `1.92.0` with rustup, and native
C/C++ tools for your platform. Linux development supports x86-64 and ARM64;
macOS development supports Apple Silicon. Windows contributors use WSL2/Linux.

```sh
git clone https://github.com/omdaniel/bedrock-surface-map.git
cd bedrock-surface-map
./dev doctor
./dev setup
./dev demo
```

`setup` installs or verifies the pinned language tools, runs `npm ci`, builds
WASM, prepares the project-local secret scanner, and creates a local synthetic
fixture. It does not download Minecraft assets or contact a Minecraft server.
`npm run bootstrap` is a compatibility alias for this same safe setup path.
`setup --offline` checks a warmed local cache and reports exactly what is absent
without accessing the network.

Run `./dev check --profile fast` before a focused change. `--profile full`
also runs workspace and WASM lints, renderer/browser checks, tracking and
terrain protocol suites, and the public-demo audit. Use
`./dev package --target x86_64-unknown-linux-musl` or
`aarch64-unknown-linux-musl` only when the pinned cargo-zigbuild and Zig tools
are available. Cross-compilation is not native runtime proof; each release
target needs its archive smoke-tested on matching Linux hardware.

`./dev setup --install-hooks` opts into the repository hook path only when no
unrelated local hook path is configured. It does not change `pull.ff`,
`push.default`, global Git configuration, or existing hooks.

Keep generated maps, worlds, credentials, downloaded Mojang assets, and release
archives outside Git. Use a `codex/` branch for substantive work, make narrow
tested commits, and update documentation to describe current behavior rather
than implementation history.
