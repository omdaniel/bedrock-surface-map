import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";

const modules = new Map([
  [
    "@minecraft/server",
    `const f = () => globalThis.terrainSchedulerFixture;
     export const system = { runInterval: (run, ticks) => f().intervals.push({run,ticks}) };
     export const world = {
       afterEvents: new Proxy({}, {get: (_, name) => ({subscribe: run => f().events.set(name, run)})}),
       getAllPlayers: () => f().players,
       getDimension: () => f().dimension,
     };
     export class BlockVolume { constructor(from,to) { this.from=from; this.to=to; } }`,
  ],
  [
    "@minecraft/server-admin",
    `export const variables = { get: key => ({world_id:'fixture', generation:'fixture',
       terrain_url:'http://192.0.2.1:8082/ingest/v1/terrain', view_distance:4, scan_budget_ms:4})[key] };
     export const secrets = { get: () => ({}) };`,
  ],
  [
    "@minecraft/server-net",
    `export class HttpRequest { constructor(url) { this.url=url; } }
     export class HttpHeader {}
     export const HttpRequestMethod = { Post:'POST' };
     export const http = { request: async request => {
       const f = globalThis.terrainSchedulerFixture;
       f.messages.push(JSON.parse(request.body));
       return {status:204};
     } };`,
  ],
  [
    "./rules.js",
    `export default ${readFileSync("terrain/rules.json", "utf8")};`,
  ],
]);
registerHooks({
  resolve(specifier, context, next) {
    const source = modules.get(specifier);
    if (source !== undefined)
      return {
        url: `data:text/javascript,${encodeURIComponent(source)}`,
        shortCircuit: true,
      };
    if (
      context.parentURL?.includes("/terrain/pack/src/") &&
      specifier.endsWith(".js")
    )
      return next(specifier.replace(/\.js$/, ".ts"), context);
    return next(specifier, context);
  },
});

async function fixture(t: TestContext) {
  let now = 1_000_000,
    ticks = 0;
  const loaded = new Set(["0,0", "1,0"]);
  const messages: Array<{
    diagnostics: {
      active_chunks: number;
      oldest_scan_ms: number;
      completed: number;
      errors: number;
    };
  }> = [];
  const intervals: Array<{ run: () => void; ticks: number }> = [];
  const events = new Map<string, () => void>();
  const players = [
    { location: { x: 0, z: 0 }, dimension: { id: "minecraft:overworld" } },
  ];
  const dimension = {
    heightRange: { min: -64, max: 320 },
    isChunkLoaded: ({ x, z }) =>
      loaded.has(`${Math.floor(x / 16)},${Math.floor(z / 16)}`),
    getTopmostBlock: () => ({
      y: 64,
      typeId: "minecraft:stone",
      permutation: { getAllStates: () => ({}) },
    }),
    getBlocks: () => ({ getBlockLocationIterator: () => [] }),
    getBiome: () => ({ id: "minecraft:plains" }),
  };
  globalThis.terrainSchedulerFixture = {
    messages,
    intervals,
    events,
    players,
    dimension,
  };
  t.mock.method(Date, "now", () => now);
  await import(`../pack/src/main.ts?fixture=${Math.random()}`);
  events.get("worldLoad")!();
  const advance = async (milliseconds: number) => {
    for (let elapsed = 0; elapsed < milliseconds; elapsed += 50) {
      now += 50;
      ticks++;
      for (const interval of intervals)
        if (ticks % interval.ticks === 0) interval.run();
      await Promise.resolve();
    }
  };
  return { advance, loaded, messages, players, dimension };
}

test("background rescans finish before the unchanged sixty-second coverage threshold", async (t) => {
  const f = await fixture(t);
  await f.advance(180_000);
  assert.ok(f.messages.length > 10);
  assert.ok(f.messages.at(-1)!.diagnostics.completed >= 6);
  assert.ok(f.messages.every((m) => m.diagnostics.errors === 0));
  assert.ok(
    f.messages.every((m) => m.diagnostics.oldest_scan_ms <= 60_000),
    "a rescan must become eligible before its coverage already expires",
  );
});

test("unloaded candidate chunks leave active coverage and are rediscovered after loading", async (t) => {
  const f = await fixture(t);
  await f.advance(5_000);
  assert.equal(f.messages.at(-1)!.diagnostics.active_chunks, 2);
  f.loaded.delete("1,0");
  await f.advance(90_000);
  assert.equal(f.messages.at(-1)!.diagnostics.active_chunks, 1);
  assert.ok(f.messages.at(-1)!.diagnostics.oldest_scan_ms <= 60_000);
  const completed = f.messages.at(-1)!.diagnostics.completed;
  f.loaded.add("1,0");
  await f.advance(5_000);
  assert.equal(f.messages.at(-1)!.diagnostics.active_chunks, 2);
  assert.ok(f.messages.at(-1)!.diagnostics.completed > completed);
  f.players.length = 0;
  await f.advance(10_000);
  assert.equal(f.messages.at(-1)!.diagnostics.active_chunks, 0);
});

test("loaded chunks with failing reads still report expired coverage", async (t) => {
  const f = await fixture(t);
  await f.advance(5_000);
  f.dimension.getBlocks = () => {
    throw Error("fixture read failure");
  };
  await f.advance(75_000);
  const diagnostics = f.messages.at(-1)!.diagnostics;
  assert.equal(diagnostics.active_chunks, 2);
  assert.ok(diagnostics.errors > 0);
  assert.ok(diagnostics.oldest_scan_ms > 60_000);
});
