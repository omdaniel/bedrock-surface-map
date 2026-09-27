import { test } from "node:test";
import assert from "node:assert/strict";
import { mapProxy } from "./map-proxy.mjs";
import { configuredLodUrl } from "../web/src/config.ts";
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
  assert.equal(result.terrain.lod_url, "/api/v1/worlds/test/terrain/lod.json");
  assert.equal(result.lod_url, undefined);
});
test("terrain proxy allows only fixed destination and exact read routes", async () => {
  for (const terrainOrigin of [
    "http://example.com:8111",
    "http://169.254.169.254:8082",
    "http://u:p@127.0.0.1:8111",
    "http://127.0.0.1:8111/path",
    "http://8.8.8.8:8111",
    "http://127.0.0.1:8111?destination=other",
    "http://127.0.0.1:8111#fragment",
  ])
    assert.throws(() => mapProxy({ ...config, terrainOrigin }));
  const proxy = mapProxy(config);
  for (const [url, method, expected] of [
    ["/api/v1/worlds/test/terrain/ingest", "GET", 404],
    ["/api/v1/worlds/test/terrain/manifest.json?url=http://evil", "GET", 404],
    ["/api/v1/worlds/test/terrain/status", "POST", 405],
    ["/viewer-config.json", "GET", 200],
    ["/api/v1/worlds/test/terrain/objects/../current.sqlite3", "GET", 404],
    ["/api/v1/worlds/test/terrain/lod.json?url=http://evil", "GET", 404],
    ["/api/v1/worlds/test/terrain/lod.json?", "GET", 404],
    ["/api/v1/worlds/test/terrain/lod.json#fragment", "GET", 404],
    ["/api/v1/worlds/test/terrain/lod.json/", "GET", 404],
    ["/api/v1/worlds/test/terrain/lod.JSON", "GET", 404],
    ["/api/v1/worlds/test/terrain/%6cod.json", "GET", 404],
    ["/api/v1/worlds/test/terrain/../lod.json", "GET", 404],
    ["/api/v1/worlds/test/terrain/lod.json/../../ingest", "GET", 404],
    ["/api/v1/worlds/test/terrain/ingest/lod.json", "GET", 404],
    ["/api/v1/worlds/other/terrain/lod.json", "GET", 404],
    ["/api/v1/worlds/test-extra/terrain/lod.json", "GET", 404],
    ["/api/v1/worlds/%74est/terrain/lod.json", "GET", 404],
    ["/api/v1/worlds/test/terrain/lod.json", "POST", 405],
    ["/api/v1/worlds/test/terrain/lod.json", "PUT", 405],
    ["/api/v1/worlds/test/terrain/lod.json", "PATCH", 405],
    ["/api/v1/worlds/test/terrain/lod.json", "DELETE", 405],
    ["/api/v1/worlds/test/terrain/lod.json", "OPTIONS", 405],
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
      assert.equal(c.terrain.lod_url, "/api/v1/worlds/test/terrain/lod.json");
      assert.equal(c.lod_url, undefined);
    }
  }
});

test("terrain opt-out selects the offline map without a live LOD URL", async (t) => {
  t.mock.method(globalThis, "fetch", () =>
    assert.fail("unexpected upstream request"),
  );
  for (const players of [false, true]) {
    const proxy = mapProxy({
      ...config,
      map: "maps/snapshot/manifest.json",
      ...(players
        ? { origin: "http://127.0.0.1:8110", fingerprint: "a".repeat(64) }
        : {}),
    });
    let body;
    await proxy(
      { url: "/viewer-config.json", method: "GET" },
      {
        setHeader() {},
        writeHead() {
          return this;
        },
        end(value) {
          body = value;
        },
      },
      () => assert.fail("fallthrough"),
    );
    const value = JSON.parse(body);
    assert.equal(value.map, "maps/snapshot/manifest.json");
    assert.equal(
      configuredLodUrl(value, new URLSearchParams()),
      value.terrain.lod_url,
    );
    assert.equal(
      configuredLodUrl(value, new URLSearchParams("terrain=off")),
      undefined,
    );
    assert.equal(
      configuredLodUrl(value, new URLSearchParams("players=off")),
      value.terrain.lod_url,
    );
    assert.equal(
      configuredLodUrl(
        value,
        new URLSearchParams("map=maps/other/manifest.json"),
      ),
      undefined,
    );
    assert.equal(Boolean(value.players), players);
  }
});

test("a live LOD binding is absent without an explicitly configured terrain origin", async () => {
  const proxy = mapProxy({ map: "maps/fixture/manifest.json" });
  let body;
  await proxy(
    { url: "/viewer-config.json", method: "GET" },
    {
      setHeader() {},
      writeHead() {
        return this;
      },
      end(value) {
        body = value;
      },
    },
    () => assert.fail("fallthrough"),
  );
  const value = JSON.parse(body);
  assert.equal(value.map, "maps/fixture/manifest.json");
  assert.equal(value.lod_url, undefined);
  assert.equal(value.terrain, undefined);
  for (const patch of [
    { world: "test/other" },
    { world: "" },
    { generation: "../generation" },
  ])
    assert.throws(
      () => mapProxy({ ...config, ...patch }),
      /explicit world\/generation/,
    );
});

test("LOD roots forward GET/HEAD and ETags with manifest revalidation, never credentials", async (t) => {
  const path = "/api/v1/worlds/test/terrain/lod.json";
  const requests = [];
  let unchanged = false;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url: url.href, options });
    return unchanged
      ? new Response(null, { status: 304, headers: { ETag: '"lod-1"' } })
      : new Response(
          options.method === "HEAD" ? null : '{"kind":"surface-lod"}',
          {
            headers: { "Content-Type": "application/json", ETag: '"lod-1"' },
          },
        );
  });
  const proxy = mapProxy(config);
  for (const [method, conditional] of [
    ["GET", false],
    ["HEAD", false],
    ["GET", true],
    ["HEAD", true],
  ]) {
    unchanged = conditional;
    let code, body;
    const headers = new Headers();
    const res = {
      setHeader(name, value) {
        headers.set(name, value);
      },
      once() {},
      writeHead(value, values = {}) {
        code = value;
        for (const [name, header] of Object.entries(values))
          headers.set(name, header);
        return this;
      },
      end(value) {
        body = value;
      },
    };
    await proxy(
      {
        url: path,
        method,
        headers: {
          cookie: "private=fixture",
          authorization: "Bearer fixture",
          ...(conditional ? { "if-none-match": '"lod-1"' } : {}),
        },
      },
      res,
      () => assert.fail("fallthrough"),
    );
    assert.equal(code, conditional ? 304 : 200);
    assert.equal(headers.get("Cache-Control"), "no-cache");
    assert.equal(headers.get("ETag"), '"lod-1"');
    assert.equal(headers.get("X-Content-Type-Options"), "nosniff");
    if (method === "HEAD" || conditional) assert.equal(body, undefined);
    else assert.deepEqual(JSON.parse(body.toString()), { kind: "surface-lod" });
    const seen = requests.at(-1);
    assert.equal(seen.url, config.terrainOrigin + path);
    assert.equal(seen.options.method, method);
    assert.equal(seen.options.redirect, "error");
    assert.deepEqual(
      seen.options.headers,
      conditional ? { "If-None-Match": '"lod-1"' } : {},
    );
  }
  assert.equal(requests.length, 4);
});
