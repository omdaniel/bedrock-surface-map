import { test } from "node:test";
import assert from "node:assert/strict";
import { mapProxy } from "./map-proxy.mjs";
const config = {
  world: "test",
  generation: "generation",
  terrainOrigin: "http://127.0.0.1:8111",
};
test("terrain proxy allows only fixed destination and exact read routes", async () => {
  for (const terrainOrigin of [
    "http://example.com:8111",
    "http://127.0.0.1:8082",
    "http://u:p@127.0.0.1:8111",
    "http://127.0.0.1:8111/path",
  ])
    assert.throws(() => mapProxy({ ...config, terrainOrigin }));
  const proxy = mapProxy(config);
  for (const [url, method, expected] of [
    ["/api/v1/worlds/test/terrain/ingest", "GET", 404],
    ["/api/v1/worlds/test/terrain/manifest.json?url=http://evil", "GET", 404],
    ["/api/v1/worlds/test/terrain/status", "POST", 405],
    ["/viewer-config.json", "GET", 200],
    ["/api/v1/worlds/test/terrain/objects/../current.sqlite3", "GET", 404],
  ]) {
    let code, body;
    const res = {
      setHeader() {},
      writeHead(c) {
        code = c;
        return this;
      },
      end(b) {
        body = b;
      },
    };
    await proxy({ url, method }, res, () => assert.fail("fallthrough"));
    assert.equal(code, expected);
    if (code === 200) {
      const c = JSON.parse(body);
      assert.equal(c.players, null);
      assert.equal(c.terrain.generation, "generation");
    }
  }
});
