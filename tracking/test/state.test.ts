import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parseView,
  PlayerState,
  binding,
  project,
} from "../../web/src/player-state.ts";
const snapshot = () =>
  JSON.parse(
    readFileSync(
      new URL("../../fixtures/tracking/snapshot.json", import.meta.url),
      "utf8",
    ),
  );
const view = () => ({
  schema_version: 1,
  world_id: "fixture-world",
  status: "live",
  reason: null,
  age_ms: 0,
  snapshot: snapshot(),
});
test("wrong-world, malformed and old data cannot appear live", () => {
  assert.throws(() => parseView(view(), "other"));
  const state = new PlayerState();
  state.accept(parseView(view(), "fixture-world"), 0);
  assert.equal(state.status(9999), "live");
  assert.equal(state.status(10000), "stale");
  state.accept(parseView(view(), "fixture-world"), 11000);
  assert.equal(state.status(11000), "stale");
  assert.equal(state.status(30000), "unavailable");
  assert.equal(state.view?.snapshot, null);
  const bad = view();
  bad.snapshot.players[0].position.x = NaN;
  assert.throws(() => parseView(bad, "fixture-world"));
  bad.snapshot = snapshot();
  bad.snapshot.sequence = 0;
  assert.throws(() => parseView(bad, "fixture-world"));
});
test("projection is CSS-pixel based; binding requires exact source fingerprint", () => {
  assert.deepEqual(
    project(
      { x: -2, y: 5, z: -3, heading: 0 },
      { cx: 0, cz: 0, scale: 2, width: 100, height: 100 },
    ),
    { x: 46, y: 44 },
  );
  const config = {
    players: {
      world_id: "w",
      source_sha256: "a".repeat(64),
      url: "/api/v1/worlds/w/players",
    },
  };
  assert.ok(binding(config, "a".repeat(64)));
  assert.equal(binding(config, "b".repeat(64)), null);
});
