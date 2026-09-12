import { system, world } from "@minecraft/server";
import { variables, secrets } from "@minecraft/server-admin";
import {
  http,
  HttpRequest,
  HttpRequestMethod,
  HttpHeader,
} from "@minecraft/server-net";
import { Publisher, Roster } from "./core.js";

const worldId = variables.get("world_id"),
  endpoint = variables.get("collector_url");
if (
  typeof worldId !== "string" ||
  !/^[A-Za-z0-9_-]{1,80}$/.test(worldId) ||
  typeof endpoint !== "string" ||
  !/^http:\/\/[A-Za-z0-9.-]+:8081\/ingest\/v1\/snapshot$/.test(endpoint)
) {
  throw Error("Surface tracker configuration missing or invalid");
}
const roster = new Roster();
const started = Date.now();
const publisher = new Publisher(
  worldId,
  `${started.toString(36)}-${Math.random().toString(36).slice(2)}`,
  started,
  () => roster.sample(world.getAllPlayers()),
  async (snapshot) => {
    const credential = secrets.get("tracker_token");
    if (!credential) throw Error("Tracker credential unavailable");
    const request = new HttpRequest(endpoint);
    request.method = HttpRequestMethod.Post;
    request.timeout = 2;
    request.headers = [
      new HttpHeader("Content-Type", "application/json"),
      new HttpHeader("x-tracker-token", credential),
    ];
    const body = JSON.stringify(snapshot);
    if (body.length > 12000) throw Error("Tracker payload bound exceeded");
    request.body = body;
    const response = await http.request(request);
    if (response.status !== 204) throw Error("Tracker request rejected");
  },
  () => roster.acknowledge(),
  () => console.warn("Surface tracker export unavailable; gameplay continues"),
);
let loaded = false;
const pump = () => {
  if (loaded) void publisher.tick(system.currentTick, Date.now());
};
world.afterEvents.worldLoad.subscribe(() => {
  loaded = true;
  pump();
});
world.afterEvents.playerSpawn.subscribe((event) => {
  roster.spawn(event.player.id);
  publisher.changed();
  system.run(pump);
});
world.afterEvents.playerLeave.subscribe((event) => {
  roster.leave(event.playerId);
  publisher.changed();
  system.run(pump);
});
world.afterEvents.playerDimensionChange.subscribe(() => {
  publisher.changed();
  system.run(pump);
});
system.runInterval(pump, 20);
