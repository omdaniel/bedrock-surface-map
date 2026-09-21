# Bedrock Surface Map

**Explore your Bedrock world in the browser.**

A responsive overhead map with textured terrain, adjustable sunlight, player
locations, and terrain updates without reloading.

### [Open the interactive demo](https://omdaniel.github.io/bedrock-surface-map/)

No installation or login. Requires a WebGPU-enabled browser.

[![A fictional player moves while a small structure appears and its center is removed](https://github.com/omdaniel/bedrock-surface-map/releases/download/demo-scene-v1/demo.gif)](https://omdaniel.github.io/bedrock-surface-map/)

_Demo playback: fictional players and scripted terrain changes, not a live server.
The animation is accelerated; the interactive demo runs a 60-second loop._

## See the World, Find Your Friends

- **Explore the landscape.** Pan from island chains to individual blocks. Water
  depth, textured surfaces, and sunlit terrain edges make the world readable;
  change the sun direction to inspect its shape.
- **Find your players.** See names and directional markers, select a player to
  center the map, or follow them while they explore.
- **Watch the world change.** With server integration enabled, surface edits
  and newly explored terrain arrive incrementally. The map keeps your camera
  position and lighting settings instead of starting over.

## What Makes It Different?

The browser receives compact surface data, not a stack of pre-rendered map images.
It draws textures, shading, and filtered overviews locally, so loaded terrain can
be explored and relit without requesting another rendered image. Live terrain
updates replace individual 16-by-16-block chunks.

Built with Rust, WebAssembly, and WebGPU. The optional server integration retains
Mojang's official Bedrock Dedicated Server; player tracking is separate from
terrain synchronization. A snapshot can also be viewed without a running server.

## Try It, Then Make It Yours

The public demo contains a frozen 1,024-by-1,024-block excerpt, original demo
textures, and two fictional players. It has **no connection to a Minecraft
server**, and its simulated edits do not alter the original world.

[Install a snapshot viewer](docs/INSTALL.md) ·
[Run locally or import your world](docs/GETTING_STARTED.md) ·
[Development and architecture](docs/DEVELOPMENT.md) ·
[Live players](docs/TRACKING.md) · [Live terrain](docs/TERRAIN-SYNC.md)

**Current boundaries:** Overworld surfaces, not full 3D interiors or a world
backup. Some materials are approximated. WebGPU is required, very wide views can
require zooming in, and live integration needs server administration and
experimental Bedrock networking APIs. This is an actively developed project,
not a one-click server installer. [Verification and limits](docs/VERIFICATION.md)

## License

Copyright (C) 2026 Oliver M Daniel.

Application source and documentation are licensed under the
[GNU AGPL version 3 only](LICENSE) (`AGPL-3.0-only`). Third-party dependencies,
Minecraft assets, world data and original demo artwork retain their separate
terms; see [asset and dependency notices](THIRD_PARTY.md).

Not an official Minecraft product. Not approved by or associated with Mojang or
Microsoft. [Asset notices and public-demo details](THIRD_PARTY.md)
