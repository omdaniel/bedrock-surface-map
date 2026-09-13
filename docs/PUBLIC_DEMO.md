# Public Demo Maintenance

The public site is a static demonstration, not a live view of an operator's server.
It uses the production renderer, codecs, picking, player layer and chunk-update
path. A small source adapter supplies fictional player snapshots and selects
precomputed terrain manifests. No global fetch interception or backend is used.

## Dataset and Playback

- Excerpt: X/Z [-512, 512), 16 regions, neutral `coastal-showcase` identity.
- Scenario: 0-15s original terrain; 15-30s a small wooden structure; 30-45s
  removal of its middle revealing the original sand; 45-60s restoration.
- Fictional players Rowan and Morgan move on scripted paths, sampled every two
  seconds. Their positions are illustrative, not a recording or gameplay simulation.
- Root revisions remain monotonic across loops and restarts. Pause and hidden-tab
  handling suspend scenario time; reduced-motion users start paused.
- Terrain snapshots are transported through the actual lossless chunk format.
  Original texture pixels are procedurally generated; no Mojang atlas is read.

The source manifest in [sources/demo.json](../sources/demo.json) pins the release,
checksum, export recipe, bounds and snapshot provenance. The packet contains a
bounded gzip-compressed JSON dictionary of base64 files, decoded only at build
time. The browser fetches normal same-origin objects, not the packet or Git LFS.

## Reproduce an Approved Export

The original private snapshot is intentionally not distributed. An operator with
the approved imported surface directory can reproduce the excerpt:

```sh
cargo run --locked --release -p surface-cli --example showcase -- \
  /path/to/imported-surface /path/to/new-showcase-output
node scripts/demo-package.mjs /path/to/new-showcase-output
```

The generator verifies input region hashes and output codec round trips. It never
contacts a game server or reads the source texture atlas. Source archive and imported
world data remain private; changes require a fresh reviewed release and checksum.
Do not overwrite an already published version with different bytes.

For public-build reproduction, no private input or Rust exporter is needed:

```sh
npm run demo:prepare
npm run demo:build
node scripts/audit-demo.mjs
DEMO_SELF_SERVE=1 node scripts/check-demo.mjs
```

## Media and Publication

`scripts/capture-demo.mjs` captures actual Chrome playback and uses ffmpeg to
produce a 10-second accelerated GIF. `scripts/check-demo.mjs` captures desktop
and mobile-layout screenshots. Inspect these locally before copying the approved
desktop image to `docs/media/demo.png` and uploading the GIF to the demo release.
Other screenshots remain ignored. No production player names appear in this media.

GitHub Pages uses the existing CI workflow. PRs run checks without publishing;
successful pushes to main publish only `.local/demo-dist`, with pinned Pages
actions and restricted deployment permissions. The artifact audit checks every
dataset file against the reviewed packet, rejects extra files and private markers,
and verifies the poster and demo-only configuration. The site is independently
hosted at <https://omdaniel.github.io/bedrock-surface-map/> with trusted HTTPS.

Rollback is a revert of the relevant application/source pin commit followed by
the same checked build. Old release objects remain available. This does not change
the Minecraft server, its packs, or any operator deployment.

## Verification

`npm run demo:test` covers clock ordering, packet integrity, unsafe entries and
expansion bounds. `scripts/check-demo.mjs` exercises two timeline loops,
monotonic restart, player-only idle rendering, center/follow, manual follow
cancellation, pause, mobile layout, reduced motion and the missing-WebGPU poster.
Terrain changes use the same decoder, picking and shadow-update path as live maps.

Run the built-site check and artifact audit above before publication. Inspect
desktop/mobile screenshots for fictional labels, visible controls and matching
terrain. Confirm runtime requests stay on the demo origin and base path.
Native Safari and physical iPad acceptance are separate from Chrome and desktop
mobile-layout checks; use the [verification guide](VERIFICATION.md).

Record initial transfer, first-visible-map latency, physical canvas resolution
and accounted map memory in the release PR. The download target is below 10 MiB
for the initial view, not a universal latency or frame-rate guarantee. The release
packet is a build-time download; visitors fetch only ordinary static site files.
Keep historical measurements in release reviews, not in this maintenance guide.
