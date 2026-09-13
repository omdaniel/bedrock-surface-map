# Color, Shadows and Terrain Relief

The renderer combines textured top surfaces, directional cast shadows and
stylized edge relief. Lighting and color settings are session-local; they do
not modify the dataset.

| Control         | Default     | Range                              |
| --------------- | ----------- | ---------------------------------- |
| Sun elevation   | 45 degrees  | 15-75 degrees                      |
| Sun azimuth     | 330 degrees | Continuously wrapping compass dial |
| Shadow strength | 55%         | 0-80%                              |
| Color           | Vivid       | Vivid / Original                   |
| Terrain relief  | 100%        | 0-100%                             |
| Relief width    | 0.25 block  | 0.05-0.50 block                    |

## Sun Direction and Cast Shadows

Azimuth is clockwise from north: north=0/360, east=90, south=180, west=270.
With +X east and +Z south, Rust constructs the direction towards the sun as
`(sin(azimuth), -cos(azimuth))`. CPU references, GPU shadows, relief and
overviews share that vector. Shadows extend in the opposite direction.

The dial supports repeated turns with mouse, pen or touch through pointer
capture. It ignores the undefined bearing at its center. Arrows adjust one
degree, Page Up/Down adjust 15, Home selects 0 and End selects 359. Values wrap;
the UI displays 360 as 0. The accessible slider exposes the bearing and units.

A max-height pyramid accelerates ray/block intersections at arbitrary azimuths.
Nodes below an ascending ray are skipped; leaves use actual column heights.
Missing coverage does not invent an occluder. Cardinal zero components are exact,
and a coordinate-scaled boundary nudge prevents traversal from sticking to edges.
Offline maps supply the complete dataset heightfield. Live maps and the demo
supply a bounded height window with offscreen shadow coverage; see
[height coverage and caching](FORMAT.md#height-coverage-and-caching).

The detail pass takes four stratified samples in the clipped pixel footprint.
The overview pass samples the whole block, then box-filters its mip chain.
This preserves fractional-block shadows without per-block meshes. A height
difference `H` casts a horizontal shadow of `H / tan(elevation)`: a ten-block
column gives 5.7735 blocks at 60 degrees, or ten blocks at 45 degrees.

This is hard, parallel-light heightfield shading. It does not simulate soft
shadows, rounded canopy lighting, translucency or full block geometry. Close-up
ray-query cost varies with terrain and sun elevation; overview shading is cached.

## Terrain-Edge Relief

Relief adds bright upper rims and corners, plus contact shade on neighboring
lower surfaces. It is an artistic depth cue, not a second light source or a
physical ambient-occlusion solver.

Each land column reads its two up-sun neighbors. Height differences create bands;
material differences and block boundaries within a flat plateau do not. Missing
neighbors do not create cliffs. Water receivers are excluded. Slab and snow steps
contribute proportionally up to a one-block height difference; taller cliffs do
not widen the accent.

Absolute X/Z light components, divided by their maximum, weight the two edges.
At 315 degrees, north and west contribute equally; at 330, north is stronger.
At 90, only east-facing rims are bright. The bands fade continuously as the
azimuth crosses a cardinal direction. Corners receive an additional highlight;
lower contact shade follows the same direction independently of cast-shadow
strength or its toggle.

Width is measured in blocks: 0.25 block spans one backing pixel at four
pixels/block and four pixels at sixteen. Analytical band/pixel overlap
anti-aliases the rims, including whole-cell coverage for filtered overviews.
Corner overlap does not double-count the straight bands.

The straight-rim coefficient is 0.55; its corner adds up to 0.25. Highlights
blend towards `min(base * 1.55 + 0.025, 1)`. Contact shade uses 0.28 with up to
0.10 at corners. Relief strength scales both. Cast shadows darken highlights
before contact shade is applied, so shaded rims do not glow through terrain.
Separately averaged shadow/relief coverage is a subpixel approximation.

Detail and overview share `relief.wgsl` and the lighting composition function.
Relief reuses height storage and adds no per-region allocation. Setting its
strength to zero skips neighbor lookups without disabling cast shadows.

## Color Treatment

**Vivid** normalizes grayscale grass/foliage texture luminance before applying
biome color, preserving texture contrast. Foliage has a darker, greener base
than grass. Mild saturation/brightness grading and richer blue water complete
the treatment. **Original** multiplies texture color directly by biome tint and
uses an ungraded base with a lighter water blue. Both use the same shadows.

Only exposed ordinary sand receives a 0.88 multiplier in Vivid after grading
and before rim lighting. This leaves room for highlights without changing
red sand, sandstone, grass, foliage, water/support blends or Original mode.
A material flag identifies sand by catalog name, not by its RGB color.

Biome palettes, aquatic plants and multilayer transparency are approximations.
See [visual comparison](VISUAL-COMPARISON.md) for evaluating appearance against
another renderer without treating it as a pixel-identical oracle.

## Tests and Local Inspection

Native GPU fixtures compare shadow samples against an independent f64 CPU
grid walker over fifteen azimuths and four elevations. Relief fixtures compare
GPU bands against CPU intersection calculations at three widths. Cases include
negative/missing heights, fractional steps, corners and region boundaries.
CPU tests also cover compass direction, odd pyramid dimensions and shadow reach.

Browser pixel tests check ledge shadows, rotating relief, sand contrast,
water exclusion, zoom-scaled widths, disabled effects and overview invalidation.
Dial tests cover pointer/touch rotation, keyboard wrapping and exact 0/360
equivalence. These tests are in `tests/viewer.spec.ts` and `tests/dial.spec.ts`.

With local Chrome, a running development viewer and an imported offline map:

```sh
node scripts/check-appearance.mjs
node scripts/check-azimuth.mjs
node scripts/check-relief.mjs
```

The scripts write ignored reports, screenshots and comparison pages under
`.local/appearance`, `.local/azimuth` and `.local/relief` by default. Views use
spawn or the `view`/`detailView` fields in [operator configuration](CONFIGURATION.md).
Azimuth and relief checks include navigation
timings and desktop/mobile layouts. Relief comparisons use off/on views at
330 degrees and reversed light at 150 degrees, not different application builds.

For an optional matching uNmINeD image, prepare the separate offline copy in the
[comparison guide](VISUAL-COMPARISON.md), then run:

```sh
.local/comparison-tools/unmined-cli_0.20.8-dev_osx-arm64/unmined-cli image render \
  --world=.local/comparison/world \
  --output=.local/appearance/unmined-beach.png \
  "--area=b($CROP_X,$CROP_Z,192,192)" --zoom=2 --shadows=3d \
  --chunkprocessors=2 --log-level=warning
```

Private comparison images and downloaded assets do not belong in Git or CI.
Set `CROP_X`/`CROP_Z` to match the configured 192-block browser crop at scale 4.
