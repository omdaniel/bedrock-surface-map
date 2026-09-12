# Color and Sub-Block Shadows

Follow-up to the initial visual comparison. The user authorized varying the
original fixed 60-degree sun to approximate uNmINeD's stronger beach relief.
Default: 45 degrees elevation, northwest azimuth, 55% shadow strength, Vivid color.
The controls allow 15-75 degrees, 0-80% strength, and Vivid/Original color. They
are session-local; changing them does not modify the imported dataset.

## Why the Original Relief Was Weak

The previous compute pass reduced each column to a binary shadow sample. A
one-block ledge under a 60-degree sun casts a 0.577-block shadow along the light
direction, or 0.408 block across an east-facing ledge with northwest illumination.
An all-or-nothing sample cannot display that narrow band correctly. Simply
lowering the sun made shadows longer without fixing the missing detail.

The compute cache now retains a floating-point occlusion horizon. With
`s = sqrt(2) * tan(elevation)`, each diagonal stores
`H(x,z) = max(height(x,z), H(x-1,z-1) - s)`.

Within a receiving block, a ray towards the northwest crosses west, north, and
diagonal cells at different fractional distances. Their three horizon values
define clipping thresholds in block-local `(u,v)` coordinates. The shader splits
the footprint at `u=v` and integrates the lit area of both triangles analytically.
This accounts for side crossings as well as diagonal occluders. It is constant
work per pixel, without per-pixel ray traversal or per-block geometry.

The detail pass uses the screen pixel's clipped footprint for anti-aliasing; the
overview pass integrates the whole block before generating its filtered levels.
Camera movement reuses the horizons. Sun-angle changes rerun the sweep and
resident overviews. Color/strength changes only regenerate overviews. The full
heightfield includes known occluders outside the resident region set, avoiding
lighting changes simply because the camera loads a neighboring region.

This is a hard, parallel-light top-heightfield approximation. Jagged block edges
and geometric canopy shadows are expected. It does not reproduce uNmINeD's bright
edge highlights, rounded canopy lighting, translucency or apparent soft shading.
The comparison does not establish uNmINeD's actual sun angle. No elevation
contours, image-map tiles or additional block meshes are introduced.

## Color Treatment

Vivid normalizes grayscale grass/foliage texture luminance before applying the
biome color, retaining texture contrast instead of multiplying two dark values.
Foliage uses a darker, greener base than grass. A restrained saturation/brightness
adjustment and richer blue water complete the treatment. Detail and overview
use shared WGSL functions. Original retains the earlier color formulas for A/B
comparison, but benefits from the new shadow calculation. Biome colors, aquatic
plants and multilayer transparency remain approximations.

## Regression Tests

- CPU one-block ledges at 30, 45 and 60 degrees: east-facing shadow coverage is
  approximately 0.707 block at 45 degrees and 0.408 block at 60 degrees.
- An independent grid-crossing ray walker supersamples randomized fields with
  negative and missing heights, checking analytical coverage within 0.045.
- Native GPU fixtures compare horizons against CPU within 0.0001, and five
  pixel footprints per cell against CPU coverage within 0.0002. Flat ground,
  a column, terraces, one-block ledges and region boundaries are covered.
- The original 10-block/60-degree test still checks the 5.7735-block shadow reach.
- A Chrome screenshot test checks that a point 0.55 block behind a sand ledge is
  dark at 45 degrees and lit at 60, while a nearer point stays shaded. It also
  checks zero shadow strength, color switching and the mobile control layout.

## Local Reference Crop

With the dev server running, `node scripts/check-appearance.mjs` captures
X `[-380,-188)`, Z `[-210,-18)` at four pixels per block. Images, a JSON state/error
report and comparison HTML are written under ignored `.local/appearance/`.
It requires local Chrome and the already-imported real map, not CI credentials.

The optional uNmINeD reference uses the separate offline world copy described
in [VISUAL-COMPARISON.md](VISUAL-COMPARISON.md):

```sh
.local/comparison-tools/unmined-cli_0.20.8-dev_osx-arm64/unmined-cli image render \
  --world=.local/comparison/world \
  --output=.local/appearance/unmined-beach.png \
  '--area=b(-380,-210,192,192)' --zoom=2 --shadows=3d \
  --chunkprocessors=2 --log-level=warning
```

The comparison page uses that reference alongside 45- and 60-degree wgpu views.
Private reference images are not committed, uploaded or included in CI artifacts.
