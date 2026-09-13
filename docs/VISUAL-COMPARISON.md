# Visual Reference Comparison

Compare geographic alignment and overall appearance with another map renderer.
uNmINeD and BedrockMap are optional visual references, not runtime dependencies,
pixel-identical oracles or equivalent performance benchmarks.

## Align the Inputs

Use the same consistent offline snapshot for this viewer and uNmINeD, with a
separate disposable world copy for the reference renderer. Match bounds, north-up
orientation and pixels per block. Do not use a live server directory or upload a
world to a service as part of a local comparison.

The local comparison scripts use X/Z `[-500,500)` at one pixel per block, with
closer island and river crops. Compare coastlines, channels, vegetation boundaries
and recognizable terrain structures at matching coordinates. Look for swapped
axes, flipped north/south, missing coverage and shifted features.

A hosted reference with an unknown snapshot hash, crop or rendering configuration
supports only a rough comparison. Agreement at a few landmarks does not establish
correctness for every block or the entire world.

## Appearance to Evaluate

- **Color:** Vivid preserves bright biome colors and texture contrast; Original
  uses direct texture/tint multiplication. Neither reproduces another renderer's
  complete biome palette or color model.
- **Relief:** fractional-block cast shadows, bright rims/corners and lower
  contact bands make one-block terraces legible. Bands rotate with azimuth and
  scale in block units. The default is 330 degrees azimuth, 45 degrees elevation;
  matching a reference by eye does not establish its internal sun settings.
- **Water:** depth shading uses retained underwater support, which can be a plant
  rather than bare seabed. Waterlogged layers and aquatic vegetation are
  approximations; different optics alone do not imply misplaced coastlines.
- **Models:** canopy, complex blocks and transparency use top-surface
  approximations. Hard heightfield shadows do not reproduce rounded canopy
  lighting or soft shadows. Relief is shading, not contour-line geometry.

See [appearance](APPEARANCE.md) for the actual shading formulas and controls.

## Run Locally

Keep the optional binary, world copy and images under ignored `.local/`.
[sources/unmined.json](../sources/unmined.json) pins the optional macOS ARM64
reference binary and checksum. Obtain it from the
[official download page](https://unmined.net/downloads/), verify the hash and
follow its [license](https://unmined.net/license/); do not redistribute it.

With the unpacked binary and offline copy in place:

```sh
.local/comparison-tools/unmined-cli_0.20.8-dev_osx-arm64/unmined-cli image render \
  --world=.local/comparison/world \
  --output=.local/comparison/unmined-origin-1000.png \
  '--area=b(-500,-500,1000,1000)' --zoom=0 --shadows=3d \
  --chunkprocessors=2 --log-level=warning
```

With the local Vite viewer running, `node scripts/capture-comparison.mjs` captures
matching views and writes a side-by-side page, state and error reports to
`.local/comparison/`. It does not serve or upload the raw world.
The [appearance checks](APPEARANCE.md#tests-and-local-inspection) provide closer
beach crops with adjustable light and relief.

Keep private reference images local. Synthetic fixtures provide automated
regressions; visual similarity is supplementary. PNG export time is not directly
comparable to interactive rendering or surface-import time.
