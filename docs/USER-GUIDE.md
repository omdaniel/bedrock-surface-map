# Use the Map

Open the [public demo](https://omdaniel.github.io/bedrock-surface-map/demo/) or the
HTTPS address supplied by your server operator. The demo has fictional players
and scripted edits; a live installation displays only its configured world.

## Find Your Bearings

- **Pan:** drag the map with a mouse or touch.
- **Zoom:** use the wheel or a pinch gesture. Zooming in reveals individual blocks;
  wider views use filtered detail.
- **Fit world:** frame the mapped terrain. **Spawn:** return to the configured
  world spawn.
- **Inspect:** point at terrain to read coordinates and surface information.
  The map shows the retained top surface, not underground rooms or inventories.

North is up, east is right. Minecraft X increases east and Z increases south.
Very wide views may ask you to zoom in to stay within the map's memory limit.
This does not mean your world data has been deleted.

## Find a Player

With tracking configured, open **Players** and select a gamertag to center on
that player. Use follow to keep them in view; manual navigation cancels follow.
Markers and labels keep their screen size as you zoom. The heading shows the
direction a player faces, rather than a prediction of their movement.

Nether and End players remain in the roster without a false Overworld marker.
A player can also be outside mapped terrain. Their actual position is still
useful even when the terrain snapshot has no coverage there.

Player and terrain freshness are separate. Stale positions are identified after
ten seconds and coordinates disappear after thirty seconds without a fresh
sample. A valid empty roster means nobody is online; it is different from an
unavailable tracker. See [player tracking](TRACKING.md).

## Read the Terrain

Use the lighting controls to change sun direction, elevation and shadow strength.
The bearing is clockwise from north: **0° north, 90° east, 180° south, 270° west**.
Vivid/Original changes color treatment; relief controls adjust the highlights and
contact shading that make height changes easier to see. Grid and shadow toggles
can simplify the view. These settings last for the browser session.

Water depth and vegetation are surface approximations. A map cannot show
everything underneath a roof, canopy or water surface. Live terrain updates
replace changed chunks without resetting your camera; an offline snapshot stays
fixed until the operator imports another one and you reload.

## If the Map Does Not Load

1. Use a current WebGPU-enabled Chrome or Safari on a supported device. WebGPU
   must be available to the browser; the map has no hidden fallback renderer.
2. Use the operator's HTTPS URL. Plain HTTP works only on loopback, such as
   `http://127.0.0.1:8080/`. The public demo needs no certificate installation.
3. If terrain loads but players do not, check whether the map is a snapshot or
   whether tracking is disabled/stale. A successful page load does not prove
   that the server feed is connected.
4. Share the displayed error, browser version and app version with the operator.
   Avoid screenshots exposing private player information in public issues.

The optional diagnostics panel helps distinguish loading, terrain residency and
rendering issues. Operators can continue with [connection checks](COMPATIBILITY.md#troubleshoot-in-order).
