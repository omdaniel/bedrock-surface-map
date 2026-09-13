import { test } from "node:test";
import assert from "node:assert/strict";
import { trackerProxy } from "./tracker-proxy.mjs";
const valid = {
  origin: "http://127.0.0.1:8110",
  world: "fixture-world",
  fingerprint: "a".repeat(64),
};
test("proxy destination is configuration, never a user-supplied URL", () => {
  for (const origin of [
    "http://169.254.169.254:8110",
    "http://example.com:8110",
    "http://u:p@127.0.0.1:8110",
    "http://127.0.0.1:8110/private",
    "ftp://127.0.0.1:8110",
  ])
    assert.throws(() => trackerProxy({ ...valid, origin }));
  assert.equal(trackerProxy({}), null);
});
test("only exact read path and public binding are routed", async () => {
  const middleware = trackerProxy(valid);
  for (const [url, method, status] of [
    ["/api/v1/worlds/fixture-world/players", "POST", 405],
    ["/api/ingest", "GET", 404],
    ["/api/v1/worlds/fixture-world/players?url=evil", "GET", 404],
    ["/viewer-config.json", "GET", 200],
  ]) {
    let actual = 0,
      body = "";
    const headers = {};
    const res = {
      setHeader: (k, v) => {
        headers[k] = v;
      },
      writeHead: (n) => {
        actual = n;
        return res;
      },
      end: (b) => {
        body = b ?? "";
      },
    };
    await middleware({ url, method }, res, () =>
      assert.fail("unexpected fallthrough"),
    );
    assert.equal(actual, status);
    assert.equal(headers["Cache-Control"], "no-store");
    if (status === 200)
      assert.equal(JSON.parse(body).players.world_id, "fixture-world");
  }
});
