import { test } from "node:test";
import assert from "node:assert/strict";
import { mapProxy } from "./map-proxy.mjs";
const config = {
  world: "test",
  generation: "generation",
  terrainOrigin: "http://127.0.0.1:8111",
};
test("operator configuration binds players and terrain on arbitrary private read ports", async () => {
  const proxy = mapProxy({
    ...config,
    terrainOrigin: "http://10.23.45.67:34567",
    origin: "http://10.23.45.67:45678",
    fingerprint: "a".repeat(64),
  });
  let body;
  const response = {
    setHeader() {},
    writeHead() {
      return this;
    },
    end(value) {
      body = value;
    },
  };
  await proxy({ url: "/viewer-config.json", method: "GET" }, response, () =>
    assert.fail("fallthrough"),
  );
  const result = JSON.parse(body);
  assert.equal(result.players.world_id, result.terrain.world_id);
  assert.equal(result.players.generation, result.terrain.generation);
  assert.equal(result.players.url, "/api/v1/worlds/test/players");
});
test("terrain proxy allows only fixed destination and exact read routes", async () => {
  for (const terrainOrigin of [
    "http://example.com:8111",
    "http://169.254.169.254:8082",
    "http://u:p@127.0.0.1:8111",
    "http://127.0.0.1:8111/path",
  ])
    assert.throws(() => mapProxy({ ...config, terrainOrigin }));
  const proxy = mapProxy(config);
  for (const [url, method, expected] of [
    ["/api/v1/worlds/test/terrain/ingest", "GET", 404],
    ["/api/v1/worlds/test/terrain/manifest.json?url=http://evil", "GET", 404],
    ["/api/v1/worlds/test/terrain/status", "POST", 405],
    ["/api/v1/worlds/test/terrain/lod.json", "POST", 405],
    ["/api/v1/worlds/test/terrain/lod.json?url=http://evil", "GET", 404],
    ["/api/v1/worlds/test/terrain/%6cod.json", "GET", 404],
    ["/api/v1/worlds/test/terrain/lod.json/", "GET", 404],
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
      assert.equal(c.terrain.lod_url, undefined);
    }
  }
});

test("live LOD configuration has one canonical top-level opt-in", async () => {
  let body;
  const res = {
    setHeader() {},
    writeHead() {
      return this;
    },
    end(value) {
      body = value;
    },
  };
  await mapProxy({ ...config, terrainLod: true })(
    { url: "/viewer-config.json", method: "GET" },
    res,
    () => assert.fail("fallthrough"),
  );
  const binding = JSON.parse(body);
  assert.equal(binding.lod_url, "/api/v1/worlds/test/terrain/lod.json");
  assert.equal(binding.terrain.lod_url, undefined);
});
