# Live Player Tracking

See who is online, find them on the map, and follow them as they explore.
Tracking works with **Mojang's official Bedrock Dedicated Server**; it does not
require replacing the game server.

[Try the interactive demo](https://omdaniel.github.io/bedrock-surface-map/) to
explore the controls. Its players are fictional, not connected to a live server.

## Using the Map

Open **Players** in the toolbar to see the roster. Select a gamertag to center
and zoom to that player; use the target button to follow them. Dragging or
zooming the map cancels follow. Nether and End players stay in the roster but
do not appear as misleading markers on the Overworld map.

Active positions target 100 ms updates while the page is visible; game tick rate,
network delay and server load affect delivery. Empty-server checks use two seconds.
If updates stop, positions are marked stale after ten seconds and removed after
thirty. A connection failure is not shown as an empty, healthy server.

## Connecting Your Server

The integration has three parts:

1. A **server behavior pack** reads player positions and sends authenticated
   snapshots over a private network.
2. A small **collector** holds the current roster in memory.
3. The **HTTPS viewer** reads that roster through a read-only proxy, keeping
   credentials and the collector's write endpoint away from browsers.

This requires server administration and the **Beta APIs** world experiment.
Back up the world and test a restored copy before enabling it. Removing the
pack does **not** undo the world's experimental status.

Bind the viewer explicitly to the intended world. Offline maps use the snapshot
fingerprint; live terrain uses the world ID and dataset generation. The viewer
can run on an always-on server; the Mac preview is only a development option.
See the [technical reference](TRACKING-REFERENCE.md) for build commands,
configuration and compatibility checks.

## Privacy and Scope

Tracking collects gamertags and current positions, not inventories, chat, XUIDs
or movement history. Without viewer access controls, anyone who can open your
map can see its player names and locations. The public demo exposes no real feed.

Player tracking and [terrain synchronization](TERRAIN-SYNC.md) are independent:
moving markers do not update an offline terrain snapshot. On a self-hosted map,
add `?players=off` to disable tracking for that view without changing the world.

## Compatibility

The [compatibility target](../tracking/compatibility.json) is BDS 1.26.45.1
with tracking pack 1.0.3. Test the pack on an isolated world when updating
Bedrock; pinned API declarations alone do not prove support. Use the
[acceptance checklist](TERRAIN-ACCEPTANCE.md) to verify your clients, coordinate
alignment, recovery and performance before relying on a deployment.
