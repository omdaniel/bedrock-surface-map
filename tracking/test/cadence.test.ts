import { test } from "node:test";
import assert from "node:assert/strict";
import { binding, playerPollDelay } from "../../web/src/player-state.ts";

test("active polling accounts for request duration without overlap or backlog", () => {
  assert.equal(playerPollDelay(100, 0, false, 15), 85);
  assert.equal(playerPollDelay(100, 0, false, 150), 0);
  assert.equal(playerPollDelay(100, 0, true, 15), 1985);
  assert.equal(playerPollDelay(100, 1, false, 0), 2000);
  assert.equal(playerPollDelay(100, 2, false, 0), 4000);
  assert.equal(playerPollDelay(100, 10, false, 0), 30000);
});
test("viewer cadence is optional and bounded operator configuration", () => {
  const players = {
    world_id: "fixture",
    source_sha256: "fixture",
    url: "/api/v1/worlds/fixture/players",
  };
  assert.ok(binding({ players }, "fixture"));
  for (const poll_interval_ms of [100, 500, 2000])
    assert.ok(
      binding({ players: { ...players, poll_interval_ms } }, "fixture"),
    );
  for (const poll_interval_ms of [null, "100", 99, 2001, NaN])
    assert.equal(
      binding({ players: { ...players, poll_interval_ms } }, "fixture"),
      null,
    );
});
