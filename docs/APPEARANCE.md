# Color and Sub-Block Shadows

Follow-up to the initial visual comparison. The user authorized varying the
original fixed 60-degree sun to approximate uNmINeD's stronger beach relief.
Default: 45 degrees elevation, 135 degrees azimuth (northwest), 55% shadow strength,
Vivid color. The controls allow 15-75 degrees elevation, 0-360 degrees azimuth in
1-degree steps, 0-80% strength, and Vivid/Original color. They
are session-local; changing them does not modify the imported dataset.

## Why the Original Relief Was Weak

The previous compute pass reduced each column to a binary shadow sample. A
one-block ledge under a 60-degree sun casts a 0.577-block shadow along the light
direction, or 0.408 block across an east-facing ledge with northwest illumination.
An all-or-nothing sample cannot display that narrow band correctly. Simply
lowering the sun made shadows longer without fixing the missing detail.

The first relief follow-up retained a floating-point occlusion horizon. With
`s = sqrt(2) * tan(elevation)`, each diagonal stores
`H(x,z) = max(height(x,z), H(x-1,z-1) - s)`.

Within a receiving block, a ray towards the northwest crosses west, north, and
diagonal cells at different fractional distances. Their three horizon values
defined clipping thresholds in block-local `(u,v)` coordinates. The shader split
the footprint at `u=v` and integrated the lit area of both triangles analytically.
This approach remains in the CPU reference tests, but is no longer the renderer's
shadow algorithm because its diagonal recurrence cannot represent arbitrary
azimuths without approximation or direction snapping.

## Full Azimuth

The user requested east=0/360, north=90, west=180, south=270. The direction towards
the sun is `(cos(azimuth), -sin(azimuth))` in map X/Z. Shadows extend oppositely.
The UI displays 360 independently but the renderer normalizes it to exactly 0.

A max-height hierarchy now accelerates ray/block intersections at any azimuth.
It is built once per snapshot, retains missing coverage as non-occluding, and
includes the entire dataset regardless of which regions are visible. Maxima
conservatively skip blocks below the ascending ray. Leaves use actual block
heights; this is not a blend of different compass-direction shadow images.
Cardinal zero components are exact, and a small coordinate-scaled boundary nudge
prevents floating-point traversal from getting stuck on a block edge.

The detail pass uses four stratified samples in the clipped pixel footprint;
the overview pass samples the whole block, then box-filters its mip chain. Thus
partial-block shadows remain visible, but coverage is now sampled rather than
analytically integrated. Fine boundaries can differ slightly from the earlier
NW-only view. No per-block geometry or exported image-map tiles are introduced.

The hierarchy and overview colors are cached. Changing either sun angle or the
color controls regenerates resident overview colors; camera motion does not.
Close-up fragments do perform accelerated ray queries on each redraw. Their cost
depends on terrain and sun elevation, unlike the old constant-work formula.
The real-browser multi-angle navigation measurements are in VERIFICATION.md.

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
- Current GPU tests compare five samples per cell against an independent f64
  block-by-block CPU DDA, using 14 azimuths and four elevations (15/45/60/75).
  Fixtures cover flat terrain, a column, terraces, negative/missing random heights
  and a 256-column boundary. Odd hierarchy dimensions and the compass convention
  have explicit CPU tests.
- The original 10-block/60-degree test still checks the 5.7735-block shadow reach.
- A Chrome screenshot test checks that a point 0.55 block behind a sand ledge is
  dark at 45 degrees and lit at 60, while a nearer point stays shaded. It also
  checks zero shadow strength, color switching and the mobile control layout.
- A second Chrome pixel test checks cast-shadow direction at cardinals and
  intermediate azimuths, exact 0/360 pixel equivalence, 1-degree keyboard steps
  and mobile-layout fit.

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

`node scripts/check-azimuth.mjs` adds six real-map azimuth captures, controlled-pan
measurements at 1920x1080 DPR1, and a mobile-layout screenshot under ignored
`.local/azimuth/`. The current algorithm's northwest beach comparisons can be
refreshed with the original `check-appearance.mjs` command.
