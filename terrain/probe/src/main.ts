import { system, world } from "@minecraft/server";
import { variables, secrets } from "@minecraft/server-admin";
import {
  http,
  HttpRequest,
  HttpRequestMethod,
  HttpHeader,
} from "@minecraft/server-net";
import { scan, type Sample } from "../../pack/src/core.js";
import { surfaceAccess } from "../../pack/src/api.js";
import rules from "../../pack/src/rules.js";

const endpoint = variables.get("terrain_url"),
  identity = variables.get("world_id"),
  generation = variables.get("generation");
if (
  identity !== "terrain-candidate" ||
  typeof generation !== "string" ||
  endpoint !== "http://surface-terrain-candidate:8082/ingest/v1/terrain"
)
  throw Error("Disposable candidate configuration required");
const url = endpoint,
  worldId = identity,
  gen = generation;
const started = Date.now(),
  producer = `probe-${started}`;
let sequence = 0,
  ready = false,
  busy = false,
  job: Generator<void, Sample> | undefined,
  last = 0,
  errors = 0;
let reader: ReturnType<typeof surfaceAccess> | undefined;
world.afterEvents.worldLoad.subscribe(() => {
  ready = true;
});
system.runInterval(() => {
  if (!ready || busy || Date.now() - last < 2000) return;
  try {
    const d = world.getDimension("overworld");
    reader ??= surfaceAccess(d);
    reader.reset();
    job ??= scan(reader.access, rules, 0, 0, Date.now);
    const start = Date.now();
    while (reader.queries <= 253 && Date.now() - start < 1) {
      const result = job.next();
      if (result.done) {
        job = undefined;
        busy = true;
        void send(result.value);
        break;
      }
    }
  } catch {
    errors++;
    job = undefined;
    last = Date.now();
  }
}, 1);
async function send(sample: Sample) {
  try {
    const token = secrets.get("terrain_token");
    if (!token) throw Error("No probe secret");
    const req = new HttpRequest(url);
    req.method = HttpRequestMethod.Post;
    req.timeout = 2;
    req.headers = [
      new HttpHeader("Content-Type", "application/json"),
      new HttpHeader("x-terrain-token", token),
    ];
    req.body = JSON.stringify({
      schema_version: 1,
      rules_version: 1,
      world_id: worldId,
      generation: gen,
      producer,
      started_ms: started,
      sequence: ++sequence,
      scan_start_ms: sample.start,
      scan_end_ms: sample.end,
      materials: sample.materials,
      chunks: [sample.chunk],
      diagnostics: {
        queued: 0,
        pending_bytes: 0,
        oldest_scan_ms: 0,
        reads: 0,
        errors,
        overflow: 0,
      },
    });
    const response = await http.request(req);
    console.warn(
      "SURFACE_TERRAIN_PROBE " +
        JSON.stringify({
          status: response.status,
          columns: sample.chunk.columns.length,
          scan_ms: sample.end - sample.start,
          errors,
          height_range: world.getDimension("overworld").heightRange,
        }),
    );
  } catch {
    console.warn("SURFACE_TERRAIN_PROBE failed");
  } finally {
    busy = false;
    last = Date.now();
  }
}
