# Color, Shadows and Terrain Relief

Follow-up to the initial visual comparison. The user authorized varying the
original fixed 60-degree sun to approximate uNmINeD's stronger beach relief.
Default: 45 degrees elevation, 330 degrees azimuth (west of north), 55% shadow strength,
Vivid color. The controls allow 15-75 degrees elevation, a continuously wrapping
azimuth dial in 1-degree steps, 0-80% shadow strength, Vivid/Original color, 0-100% terrain relief
(default 100%), and 0.05-0.50 block edge width (default 0.25). They
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

Azimuth follows the [NOAA convention](https://gml.noaa.gov/grad/solcalc/glossary.html):
clockwise from north, with north=0/360, east=90, south=180, west=270. In map X/Z,
+X is east and +Z is south, so the direction towards the sun is directly
`(sin(azimuth), -cos(azimuth))`. Shadows extend oppositely. Rust constructs this
vector once; CPU references, GPU cast shadows, relief and overviews share it.

The circular compass control uses the same bearing directly, not a translation
to the former convention. Mouse, pen and touch use pointer capture, so a drag
can circle repeatedly in either direction or continue outside the control.
The undefined bearing at the center is ignored. Arrow keys adjust one degree,
Page Up/Down adjust 15, Home selects 0 and End selects 359; adjustments wrap.
The accessible slider role exposes the current bearing and units. There is no
CSS rotation transition that could animate a long reverse sweep at north.
The UI canonicalizes 360 to 0; the renderer accepts either as exactly north.

Migration note: the former east-origin, counterclockwise default of 120 degrees
is the same physical direction as 330 in this convention. This equivalence is
recorded only for historical interpretation; no legacy conversion remains in
the application. Angle settings were never persisted in map files. New diagnostic
reports explicitly tag their azimuth convention as `north-clockwise`.

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
and geometric canopy shadows are expected. The separate terrain relief below
approximates the observed edge highlights, not rounded canopy lighting,
translucency or soft cast shadows. The comparison does not establish uNmINeD's
actual sun angle. No contour geometry, image-map tiles or additional block
meshes are introduced.

## Terrain-Edge Relief

The user's reference observation is a narrow lightened upper rim, extra corner
highlight, and a dark band on the neighboring lower surface, in addition to
cast shadows. This is an artistic depth cue, not another physical sun or a
claim about uNmINeD's implementation. The matched follow-up crop uses the user's
estimated 330-degree compass bearing; this is also the app default at the user's request.

For each land column, the shader reads its two up-sun neighbors from the complete
heightfield. Height differences create bands; material differences or block
boundaries inside an equal-height plateau do not. Higher receivers get bright
rims, lower receivers get contact shade. Missing/out-of-bounds neighbors do not
invent cliffs. Water receivers are excluded to avoid outlining underwater
support changes. Slabs and snow-layer steps contribute proportionally up to a
one-block height difference; larger cliffs do not widen the accent.

The light vector's absolute X/Z components, divided by their maximum, weight
the two edges continuously. At 315 degrees, north and west contribute equally;
at 330, north is stronger than west. At 90, only east-facing rims are bright;
at 180, only south-facing rims are bright. Rotating through a cardinal direction
fades one band to zero before bringing it up on the opposite side. Corners where
two lit edges meet receive an additional highlight. Lower contact shade follows
the same compass, independent of the main cast-shadow toggle or strength.

Default width is 0.25 block: one backing pixel at 4 pixels/block, four at 16,
and a fractional contribution when zoomed out. Width is adjustable, not capped
at one screen pixel. Exact analytical band/pixel overlap anti-aliases the rims;
whole-cell coverage feeds the existing GPU-filtered overview levels. Corner
overlap is accounted for without double-counting the two straight bands.

The straight-rim coefficient is 0.55; corner overlap adds up to 0.25. These blend
toward `min(base * 1.55 + 0.025, 1)`, preserving more foliage color than a white
overlay. Straight contact shade is 0.28 with up to 0.10 extra at its corner.
The Terrain relief control scales both. Main cast shadows still darken bright
rims, so occluded highlights do not glow through terrain. This is not a physical
ambient-occlusion solver. Multiplying separately averaged shadow/relief coverage
and per-region overview filtering remain approximations at subpixel scales.

Detail and overview share `relief.wgsl` and the composition function. Two height
lookups reuse the existing hierarchy; no new per-region GPU allocation is made.
Azimuth, strength or width changes regenerate cached overview colors. Setting
relief to zero skips its height lookups; it does not disable the primary shadows.

## Color Treatment

Vivid normalizes grayscale grass/foliage texture luminance before applying the
biome color, retaining texture contrast instead of multiplying two dark values.
Foliage uses a darker, greener base than grass. A restrained saturation/brightness
adjustment and richer blue water complete the treatment. Detail and overview
use shared WGSL functions. Original retains the earlier color formulas for A/B
comparison, but benefits from the new shadow calculation. Biome colors, aquatic
plants and multilayer transparency remain approximations.

Only ordinary exposed sand receives an additional 0.88 multiplier in Vivid,
after color grading and before rim lighting. This lowers its base without
increasing shadow strength or altering the other material palettes. Red sand,
sandstone, grass/foliage, water/support blends and Original mode are unaffected.
The shader uses an existing spare material flag, not an RGB-color heuristic.
The browser regression compares the same synthetic scene with/without that
classification, checking darker sand, increased rim contrast and unchanged
grass/stone/water/Original pixels.

## Regression Tests

- CPU one-block ledges at 30, 45 and 60 degrees: east-facing shadow coverage is
  approximately 0.707 block at 45 degrees and 0.408 block at 60 degrees.
- An independent grid-crossing ray walker supersamples randomized fields with
  negative and missing heights, checking analytical coverage within 0.045.
- Current GPU tests compare five samples per cell against an independent f64
  block-by-block CPU DDA, using 15 azimuths and four elevations (15/45/60/75).
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
- The same native GPU fixtures check relief against an independent CPU
  enumeration of the four band intersections, at three widths and all 15 angles.
  They include missing heights and cross-region lookups, with tolerance 1e-5.
- CPU checks cover flat interiors, missing neighbors, stronger corners,
  fractional step heights, 330-degree weighting, opposite directions and
  whole-block integration. Chrome pixel tests cover rotating highlights/contact
  shade, width in actual pixels at two zoom levels, disabled relief, overview
  invalidation, and scrollable controls in short landscape layouts.

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

`node scripts/check-azimuth.mjs` adds eight real-map azimuth captures, controlled-pan
measurements at 1920x1080 DPR1, and a mobile-layout screenshot under ignored
`.local/azimuth/`. The current algorithm's northwest beach comparisons can be
refreshed with the original `check-appearance.mjs` command.

`node scripts/check-relief.mjs` creates ignored `.local/relief/index.html` with
matched 330-degree before/after/uNmINeD beach views, 16-pixel/block close-ups,
and a 150-degree opposite-light view. It uses the optional reference image above.
It also records real-Chrome 1080p navigation with relief off/on, nonblank pixel
checks, and portrait/short-landscape control screenshots. No private images or
downloaded textures enter source control or CI.
