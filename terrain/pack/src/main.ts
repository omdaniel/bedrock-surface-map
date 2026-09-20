import { system, world } from "@minecraft/server";
import { variables, secrets } from "@minecraft/server-admin";
import {
  http,
  HttpHeader,
  HttpRequest,
  HttpRequestMethod,
} from "@minecraft/server-net";
import {
  scan,
  WorkQueue,
  Outbox,
  UNKNOWN,
  TransientSurfaceError,
  type Sample,
} from "./core.js";
import rules from "./rules.js";
import { surfaceAccess } from "./api.js";
import { validTerrainUrl } from "./config.js";

const worldId = variables.get("world_id"),
  generation = variables.get("generation"),
  endpoint = variables.get("terrain_url");
if (
  typeof worldId !== "string" ||
  typeof generation !== "string" ||
  ![worldId, generation].every((v) => /^[A-Za-z0-9_-]{1,80}$/.test(v)) ||
  !validTerrainUrl(endpoint)
)
  throw Error("Terrain configuration invalid");
const config = { worldId, generation, endpoint };
const started = Date.now(),
  producer = `${started.toString(36)}-${Math.random().toString(36).slice(2)}`;
const queue = new WorkQueue(),
  outbox = new Outbox();
const view = Math.min(
  16,
  Math.max(4, Number(variables.get("view_distance") ?? 16)),
);
const configuredBudget = Number(variables.get("scan_budget_ms") ?? 1);
const scanBudget = Number.isFinite(configuredBudget)
  ? Math.max(1, Math.min(4, configuredBudget))
  : 1;
let sequence = 0,
  loaded = false,
  inFlight = false,
  retryAt = 0,
  backoff = 1000,
  lastSend = 0,
  reads = 0,
  errors = 0,
  unloaded = 0,
  completed = 0,
  lastScan = 0,
  maxScan = 0,
  scanErrors = 0,
  sendErrors = 0,
  work = 0;
let current:
  | { job: Generator<void, Sample>; cx: number; cz: number; start: number }
  | undefined;
let discovery: Array<[number, number]> = [],
  discoveryIndex = 0;
let reader: ReturnType<typeof surfaceAccess> | undefined;
const coverage = new Map<string, number>();
function mark(x: number, z: number) {
  queue.mark(Math.floor(x / 16), Math.floor(z / 16), Date.now(), true);
}
function around(x: number, z: number) {
  for (const [dx, dz] of [
    [0, 0],
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ])
    mark(x + dx, z + dz);
}
world.afterEvents.playerBreakBlock.subscribe((e) => {
  if (e.dimension.id === "minecraft:overworld") around(e.block.x, e.block.z);
});
world.afterEvents.playerPlaceBlock.subscribe((e) => {
  if (e.dimension.id === "minecraft:overworld") around(e.block.x, e.block.z);
});
world.afterEvents.playerInteractWithBlock.subscribe((e) => {
  if (e.block.dimension.id === "minecraft:overworld")
    around(e.block.x, e.block.z);
});
world.afterEvents.blockExplode.subscribe((e) => {
  if (e.dimension.id === "minecraft:overworld") around(e.block.x, e.block.z);
});
world.afterEvents.pistonActivate.subscribe((e) => {
  if (e.dimension.id !== "minecraft:overworld") return;
  mark(e.block.x, e.block.z);
  for (let z = -1; z <= 1; z++)
    for (let x = -1; x <= 1; x++)
      if (x || z) mark(e.block.x + x * 16, e.block.z + z * 16);
});
world.afterEvents.worldLoad.subscribe(() => {
  loaded = true;
});
system.runInterval(() => {
  if (!loaded) return;
  try {
    const candidates = new Map<string, [number, number]>();
    for (const p of world.getAllPlayers()) {
      if (p.dimension.id !== "minecraft:overworld") continue;
      const cx = Math.floor(p.location.x / 16),
        cz = Math.floor(p.location.z / 16);
      for (let radius = 0; radius <= view; radius++)
        for (let z = -radius; z <= radius; z++)
          for (let x = -radius; x <= radius; x++) {
            if (Math.max(Math.abs(x), Math.abs(z)) !== radius) continue;
            candidates.set(`${cx + x},${cz + z}`, [cx + x, cz + z]);
          }
    }
    const next = Array.from(candidates.values()).slice(0, 8192);
    for (const key of coverage.keys())
      if (!candidates.has(key)) coverage.delete(key);
    // Keep progressing through distant loaded chunks when a scan spans refreshes.
    discovery = next;
    discoveryIndex %= Math.max(1, discovery.length);
  } catch {
    errors++;
  }
}, 40);
const due = new Map<string, number>();
system.runInterval(() => {
  if (!loaded) return;
  const begin = Date.now(),
    dimension = world.getDimension("overworld");
  reader ??= surfaceAccess(dimension);
  reader.reset();
  try {
    while (reader.queries <= 250 && Date.now() - begin < scanBudget) {
      if (!current) {
        const next = queue.take(Date.now(), ++work % 4 === 0);
        if (next) {
          if (!reader.access.loaded(next.cx * 16, next.cz * 16)) {
            unloaded++;
            coverage.delete(`${next.cx},${next.cz}`);
            continue;
          }
          const key = `${next.cx},${next.cz}`;
          if (!coverage.has(key)) coverage.set(key, Date.now());
          current = {
            cx: next.cx,
            cz: next.cz,
            start: Date.now(),
            job: scan(reader.access, rules, next.cx, next.cz, Date.now),
          };
        } else if (discoveryIndex < discovery.length) {
          const [cx, cz] = discovery[discoveryIndex++],
            key = `${cx},${cz}`;
          if (
            (due.get(key) ?? 0) <= Date.now() &&
            reader.access.loaded(cx * 16, cz * 16)
          )
            queue.mark(cx, cz, Date.now());
          continue;
        } else break;
      }
      const result = current.job.next();
      if (result.done) {
        outbox.offer(result.value);
        completed++;
        lastScan = result.value.end;
        maxScan = Math.max(maxScan, result.value.end - result.value.start);
        coverage.set(`${current.cx},${current.cz}`, lastScan);
        due.set(`${current.cx},${current.cz}`, Date.now() + 60000);
        current = undefined;
        while (due.size > 8192) due.delete(due.keys().next().value!);
      }
    }
  } catch (error) {
    const unavailable = /unloaded/i.test(String(error));
    const transient = error instanceof TransientSurfaceError;
    if (unavailable) unloaded++;
    else if (!transient) {
      errors++;
      scanErrors++;
    }
    if (current) {
      const key = `${current.cx},${current.cz}`;
      if (unavailable) {
        // Rediscovery retries once a player loads this chunk again.
        coverage.delete(key);
        due.set(key, Date.now() + 5000);
      } else
        queue.mark(
          current.cx,
          current.cz,
          Date.now() + (transient ? 250 : 5000),
          transient,
        );
    }
    current = undefined;
  }
  reads += reader.queries;
  void publish();
}, 1);
async function publish() {
  const now = Date.now();
  if (inFlight || now < retryAt) return;
  const pending = outbox.next();
  if (!pending && now - lastSend < 5000) return;
  const sample = pending?.[1].sample;
  const body = JSON.stringify({
    schema_version: 1,
    rules_version: rules.version,
    world_id: config.worldId,
    generation: config.generation,
    producer,
    started_ms: started,
    sequence: ++sequence,
    scan_start_ms: sample?.start ?? now,
    scan_end_ms: sample?.end ?? now,
    materials: sample?.materials ?? [UNKNOWN],
    chunks: sample ? [sample.chunk] : [],
    diagnostics: {
      queued: queue.size,
      pending_bytes: outbox.bytes,
      oldest_scan_ms: Math.max(
        0,
        now -
          Math.min(
            queue.oldest,
            outbox.oldest,
            current?.start ?? now,
            ...coverage.values(),
          ),
      ),
      reads,
      errors,
      completed,
      unloaded,
      active_chunks: coverage.size,
      last_scan_ms: lastScan,
      max_scan_ms: maxScan,
      scan_errors: scanErrors,
      send_errors: sendErrors,
      overflow: queue.overflow + outbox.overflow,
    },
  });
  if (body.length > 256 * 1024) {
    errors++;
    retryAt = now + 30000;
    return;
  }
  const secret = secrets.get("terrain_token");
  if (!secret) {
    retryAt = now + 30000;
    return;
  }
  const request = new HttpRequest(config.endpoint);
  request.method = HttpRequestMethod.Post;
  request.timeout = 2;
  request.headers = [
    new HttpHeader("Content-Type", "application/json"),
    new HttpHeader("x-terrain-token", secret),
  ];
  request.body = body;
  inFlight = true;
  try {
    const response = await http.request(request);
    if (response.status !== 204) throw Error(`HTTP_${response.status}`);
    if (pending) outbox.acknowledge(pending[0], pending[1].key);
    lastSend = Date.now();
    backoff = 1000;
    retryAt = 0;
  } catch {
    errors++;
    sendErrors++;
    retryAt = Date.now() + backoff;
    backoff = Math.min(30000, backoff * 2);
  } finally {
    inFlight = false;
  }
}
