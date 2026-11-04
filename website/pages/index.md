---
sidebar: false
outline: false
prev: false
next: false
title: Bedrock Surface Map
description: Installation, usage and development documentation for Bedrock Surface Map.
---

<script setup>
import { withBase } from 'vitepress';
</script>

# Bedrock Surface Map

A self-hosted browser map for Minecraft Bedrock worlds. View an offline snapshot,
or connect the official Bedrock Dedicated Server for live player positions and
terrain updates.

[Try the demo](https://omdaniel.github.io/bedrock-surface-map/demo/) ·
[Source code](https://github.com/omdaniel/bedrock-surface-map) ·
[Downloads](https://github.com/omdaniel/bedrock-surface-map/releases/latest)

<div class="feature-previews" aria-label="Map screenshots">
  <figure>
    <a :href="withBase('/docs/media/demo.png')"><img :src="withBase('/docs/media/demo.png')" width="1440" height="1000" alt="Coastal terrain with textured blocks, water and height shadows"></a>
    <figcaption><a href="https://omdaniel.github.io/bedrock-surface-map/demo/">Explore terrain in the demo</a></figcaption>
  </figure>
  <figure>
    <a :href="withBase('/docs/media/demo-players.png')"><img :src="withBase('/docs/media/demo-players.png')" width="960" height="640" alt="Fictional Rowan and Morgan markers beside the Players roster"></a>
    <figcaption><a href="./docs/USER-GUIDE.html#find-a-player">Locate and follow players</a></figcaption>
  </figure>
  <figure>
    <a :href="withBase('/docs/media/demo-lighting.png')"><img :src="withBase('/docs/media/demo-lighting.png')" width="960" height="640" alt="Sun direction dial, shadow and terrain-relief controls beside the map"></a>
    <figcaption><a href="./docs/USER-GUIDE.html#read-the-terrain">Adjust sunlight and relief</a></figcaption>
  </figure>
</div>

<p class="preview-note">Screenshots use the demo’s fictional players and simulated activity. Click an image to enlarge.</p>

## For users

- **Use an existing map:** [Controls and player markers](docs/USER-GUIDE.md).
  The map requires a WebGPU-capable browser.
- **View your own world:** [Install the snapshot viewer](docs/INSTALL.md) on
  Linux, then [prepare a world export](docs/WORLD-EXPORT.md).
- **Add a live map to a server:** [Download the operator bundle](docs/OPERATOR-INSTALL.md),
  then follow the [Docker](docs/QUICKSTART-BDS.md), [Crafty/AMP](docs/PANELS.md)
  or [HTTPS deployment](docs/DEPLOYMENT.md) guide.
- **Check requirements or troubleshoot:** [Compatibility and connection checks](docs/COMPATIBILITY.md).

## For developers

Development uses synthetic fixtures; a Minecraft account or running server is
not required.

- [Contribution guide](CONTRIBUTING.md): choose a component and its local checks.
- [Source setup](docs/GETTING_STARTED.md#run-the-demo-locally): install the tools and run locally.
- [Architecture](docs/DEVELOPMENT.md): crates, browser code and server packs.
- [Configuration](docs/CONFIGURATION.md), [surface format](docs/FORMAT.md),
  [player tracking](docs/TRACKING-REFERENCE.md) and [terrain synchronization](docs/TERRAIN-SYNC.md).
- [Edit this documentation site](docs/WEBSITE.md) using Node.js only.

## Scope

Overworld surfaces only; this is not an underground map or a world backup.
Live integration requires server administration and the Beta APIs experiment.
See [limits and verification](docs/VERIFICATION.md).
