# Working Agreements

- Application source belongs in the public omdaniel/bedrock-surface-map repository.
- Use incremental tested commits on codex/ branches. Never force push.
- Documentation describes current code, behavior, configuration and limitations in
  present tense. Keep implementation chronology, superseded decisions, rollout
  narratives and dated test results in commits/PRs, not documentation archives.
  Update affected docs with behavior changes; keep reproducible verification
  procedures, compatibility requirements, asset attribution and license notices.
- Never commit worlds, player data, downloaded Minecraft assets, credentials or build artifacts.
- Reviewed public-demo screenshots may be committed under docs/media; derived demo
  datasets and animation belong in hash-pinned releases, never Git or production feeds.
- The importer accepts offline archives only; tracking never reads live LevelDB.
- Live-player deployment belongs in runproxmox. Production experiment activation requires
  backup-derived test evidence and explicit owner approval; keep other homelab services unchanged.
- Rust/WASM/wgpu/WGSL terrain renderer; no Vello or exported map-image tiles.
- Pin toolchains and dependencies. Run tests, lint, WASM build and browser checks before delivery.
- Use apply_patch for manual edits. Prefer uv for dependency-backed Python commands.
- Keep installation addresses, world identities and account policies in operator
  configuration. Tests use synthetic fixtures and loopback services, not a homelab.
