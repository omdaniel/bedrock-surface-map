# Visual Reference Comparison

Checked September 11, 2026 on the M1 Pro Mac. These are qualitative geographic
and appearance checks, not pixel-identical oracles or performance comparisons.
Neither reference renderer is a runtime dependency.

## Inputs and Alignment

- Our viewer and uNmINeD read the same offline export identified in
  [VERIFICATION.md](VERIFICATION.md). uNmINeD reads a separate disposable copy;
  the original archive remains unchanged. No new world upload was performed.
- uNmINeD CLI 0.20.8-dev, revision
  `0ab4b8eb0ca4089c019007774d4d05744d641b2d`, from the
  [official download page](https://unmined.net/downloads/). The optional binary
  fingerprint is recorded in [sources/unmined.json](../sources/unmined.json).
- The user's [BedrockMap world-416](https://bedrockmap.net/map/world-416) displayed
  "Last Rendered: 9/11/2026, 8:50:33 PM". Its axis labels and visible crop place
  it approximately at X/Z -500 to +500. The service's source hash and exact
  rendering settings are not available from this visual check.
- Our fixed comparison crop is X/Z `[-500, 500)`, north up, 1000 x 1000 pixels
  at one pixel per block. uNmINeD uses the same bounds and resolution. The web
  reference was inspected at its own zoom levels, not resampled as an oracle.

## Findings

| Feature | Observation |
| --- | --- |
| Western island chain | Beaches, forested islands, narrow channels and their orientation agree in all three views. |
| Small central grassy island | Shape and sand cap agree around X 0, Z -160. |
| Eastern beach landmark | The brown boat-shaped block structure near X -84, Z +16 appears in the same position in our view and BedrockMap's close view. This is terrain, not a tracked player/entity. |
| Southern river | The bend around the grassy clearing near X -256, Z +336 agrees, including its outlet to the ocean. |
| Small offshore island | The north/south-oriented wooded island near X +64, Z +208 agrees. |
| Northeastern dry terrain | Dry biome coast, rocky hill and neighboring water features agree. |
| Canopy detail | The first comparison exposed gray leaf-litter patches. The corrected view preserves the supporting terrain and renders tinted litter as a thin overlay; the pale speckles are gone. |

No gross coordinate transposition, north/south flip, missing island or shifted
coastline was observed within the shared crop. This is not exhaustive verification
of every block, and the external render does not cover our complete dataset.

## Deliberate Differences and Remaining Work

- Our grass and leaves are darker and more olive. Biome tinting uses a bounded
  palette and leaf litter uses an explicitly approximate fixed dry-foliage tint.
  The references use different coloring, lighting and transparency choices.
- uNmINeD and BedrockMap show stronger relief and terrace-edge detailing. Our
  design deliberately omits contour lines and uses northwest sunlight at 60
  degrees with cast shadows. Their relief appearance is not an exact target.
- Water depth shading and submerged plants differ noticeably. The retained
  support can be the first underwater vegetation block, not the bare seabed,
  and an exposed aquatic primary surface can look too prominent. Full
  waterlogged-layer/vegetation compositing remains a known approximation, not
  proof of misplaced coastlines. Do not claim identical water optics.
- Complex models and multilayer transparency remain top-surface approximations.
  Geographic similarity does not mean Minecraft's complete materials/shading
  model has been reproduced.

## Reproduce Locally

Keep the optional uNmINeD download, extracted binary, world copy and images under
ignored `.local/`. Follow its [personal-use license](https://unmined.net/license/);
do not redistribute the executable. Do not use a live server directory.

After extracting the official archive and the verified offline world copy:

```sh
.local/comparison-tools/unmined-cli_0.20.8-dev_osx-arm64/unmined-cli image render \
  --world=.local/comparison/world \
  --output=.local/comparison/unmined-origin-1000.png \
  '--area=b(-500,-500,1000,1000)' --zoom=0 --shadows=3d \
  --chunkprocessors=2 --log-level=warning
```

With the local Vite viewer running:

```sh
node scripts/capture-comparison.mjs
```

This records the matching origin crop plus island and river details, browser
state and errors under `.local/comparison/`. The generated `index.html` compares
the local origin images side by side. It does not serve or upload the raw world.
Reference images are not committed or sent to CI; synthetic fixtures remain the
automated regression tests. Timing this optional PNG export is not an equivalent
comparison to our interactive renderer or surface-import pipeline.
