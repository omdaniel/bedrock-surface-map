# Working Agreements

- Application source belongs in the private omdaniel/bedrock-surface-map repository.
- Use incremental tested commits on codex/ branches. Never force push.
- Never commit worlds, player data, downloaded Minecraft assets, credentials or build artifacts.
- The importer accepts offline archives only. Never connect this prototype to production Minecraft.
- Keep runproxmox and every homelab service unchanged.
- Rust/WASM/wgpu/WGSL terrain renderer; no Vello or exported map-image tiles.
- Pin toolchains and dependencies. Run tests, lint, WASM build and browser checks before delivery.
- Use apply_patch for manual edits. Prefer uv for dependency-backed Python commands.
