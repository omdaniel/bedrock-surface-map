import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  scan,
  height,
  empty,
  Outbox,
  WorkQueue,
  type Access,
  type Rules,
  type Material,
} from "../pack/src/core.ts";
const rules = JSON.parse(readFileSync("terrain/rules.json", "utf8")) as Rules;
const material = (name: string, states = {}) => ({
  name: `minecraft:${name}`,
  states,
});
function fixture(stack: Record<number, Material>, loaded = true): Access {
  return {
    minimum: -64,
    loaded: () => loaded,
    top: () => {
      const y = Math.max(...Object.keys(stack).map(Number));
      return Number.isFinite(y) ? { y, material: stack[y] } : undefined;
    },
    block: (_x, y) => ({ y, material: stack[y] ?? material("air") }),
    biome: () => "minecraft:plains",
  };
}
function finish(access: Access) {
  const job = scan(access, rules, -1, -17, () => 123);
  for (;;) {
    const r = job.next();
    if (r.done) return r.value;
  }
}
test("complete negative-coordinate surface, roof removal and empty terrain", () => {
  const ground = material("stone"),
    roof = material("oak_planks");
  assert.equal(
    finish(fixture({ 0: ground, 10: roof })).chunk.columns[0][1],
    176,
  );
  assert.equal(finish(fixture({ 0: ground })).chunk.columns[0][1], 16);
  assert.deepEqual(
    finish(fixture({})).chunk.columns,
    Array.from({ length: 256 }, empty),
  );
  assert.throws(() => finish(fixture({ 0: ground }, false)), /unloaded/);
});
test("water support, grass overlay, snow and slab fractions", () => {
  const s = finish(
    fixture({
      0: material("sand"),
      1: material("water"),
      2: material("water"),
    }),
  );
  assert.equal(s.chunk.columns[0][1], 48);
  assert.equal(s.chunk.columns[0][7], 2);
  assert.equal(s.chunk.columns[0][9], 16);
  const overlay = finish(
    fixture({ 0: material("grass_block"), 1: material("short_grass") }),
  );
  assert.equal(overlay.chunk.columns[0][1], 16);
  assert.ok(overlay.chunk.columns[0][5] > 0);
  assert.equal(height({ y: -1, material: material("oak_slab") }), -8);
  assert.equal(
    height({ y: 0, material: material("oak_slab", { top_slot_bit: true }) }),
    16,
  );
  assert.equal(
    height({ y: 0, material: material("snow_layer", { height: 2 }) }),
    6,
  );
});
test("redundant legacy API states normalize without dropping other permutation fields", () => {
  const s = finish(
    fixture({
      0: material("stone", { stone_type: "stone" }),
      1: material("short_grass", { tall_grass_type: "default" }),
    }),
  );
  assert.deepEqual(s.materials[1].states, {});
  assert.deepEqual(s.materials[2].states, {});
  const distinct = finish(
    fixture({ 0: material("stone", { stone_type: "granite" }) }),
  );
  assert.deepEqual(distinct.materials[1].states, { stone_type: "granite" });
});
test("latest pending sample survives an older in-flight acknowledgement", () => {
  const a = finish(fixture({ 0: material("stone") })),
    b = finish(fixture({ 1: material("stone") }));
  const box = new Outbox();
  box.offer(a);
  const sent = box.next()!;
  box.offer(b);
  box.acknowledge(sent[0], sent[1].key);
  assert.equal(box.next()![1].sample.chunk.columns[0][1], 32);
  const latest = box.next()!;
  box.acknowledge(latest[0], latest[1].key);
  box.offer(b);
  assert.equal(box.next(), undefined);
  box.resetAcknowledged();
  box.offer(b);
  assert.ok(box.next());
});
test("dirty queue coalesces edits and retains delayed retries", () => {
  const q = new WorkQueue();
  q.mark(-1, 0, 5);
  q.mark(-1, 0, 3, true);
  q.mark(0, 0, 2);
  assert.equal(q.size, 2);
  assert.equal(q.take(5)?.cx, -1);
  assert.equal(q.take(5)?.cx, 0);
  assert.equal(q.take(5), undefined);
});
