import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mapProxy } from "./map-proxy.mjs";
import { configuredLodUrl } from "../web/src/config.ts";

test("real proxies use ephemeral read ports without exposing arbitrary routes or credentials", async () => {
  const servers = [],
    requests = [];
  const listen = async (handler) => {
    const server = createServer(handler);
    await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
    servers.push(server);
    return `http://127.0.0.1:${server.address().port}`;
  };
  try {
    const reader = (feed) => (req, res) => {
      requests.push({
        feed,
        path: req.url,
        method: req.method,
        headers: req.headers,
      });
      const lod = feed === "terrain" && req.url.endsWith("/lod.json");
      if (lod && req.headers["if-none-match"] === '"lod-1"') {
        res.writeHead(304, { ETag: '"lod-1"' }).end();
        return;
      }
      res
        .writeHead(200, {
          "Content-Type": "application/json",
          ...(lod ? { ETag: '"lod-1"' } : {}),
        })
        .end(JSON.stringify({ feed }));
    };
    const players = await listen(reader("players")),
      terrain = await listen(reader("terrain"));
    const proxy = mapProxy({
      origin: players,
      terrainOrigin: terrain,
      world: "independent-world",
      generation: "independent-generation",
      fingerprint: "a".repeat(64),
      map: "maps/fixture/manifest.json",
    });
    const viewer = await listen((req, res) => {
      void proxy(req, res, () => {
        if (req.url === "/maps/fixture/manifest.json")
          res
            .writeHead(200, { "Content-Type": "application/json" })
            .end('{"feed":"offline"}');
        else res.writeHead(404).end();
      });
    });
    const configuration = await (
      await fetch(viewer + "/viewer-config.json")
    ).json();
    assert.equal(configuration.map, "maps/fixture/manifest.json");
    assert.equal(
      configuration.terrain.lod_url,
      "/api/v1/worlds/independent-world/terrain/lod.json",
    );
    assert.equal(configuration.lod_url, undefined);
    assert.equal(
      configuredLodUrl(configuration, new URLSearchParams("terrain=off")),
      undefined,
    );
    const offline = await fetch(new URL(configuration.map, viewer));
    assert.equal(offline.status, 200);
    assert.equal((await offline.json()).feed, "offline");
    assert.equal(requests.length, 0);
    for (const [path, feed] of [
      [configuration.players.url, "players"],
      [configuration.terrain.url, "terrain"],
      [configuration.terrain.lod_url, "terrain"],
    ]) {
      const response = await fetch(viewer + path, {
        headers: { Cookie: "private=fixture", Authorization: "Bearer fixture" },
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).feed, feed);
      const seen = requests.at(-1);
      assert.equal(seen.headers.cookie, undefined);
      assert.equal(seen.headers.authorization, undefined);
      if (path === configuration.terrain.lod_url) {
        assert.equal(response.headers.get("cache-control"), "no-cache");
        assert.equal(response.headers.get("etag"), '"lod-1"');
        assert.equal(seen.method, "GET");
      }
      assert.equal(
        (await fetch(viewer + path, { method: "HEAD" })).status,
        200,
      );
    }
    for (const method of ["GET", "HEAD"]) {
      const response = await fetch(viewer + configuration.terrain.lod_url, {
        method,
        headers: {
          "If-None-Match": '"lod-1"',
          Cookie: "private=fixture",
          Authorization: "Bearer fixture",
        },
      });
      assert.equal(response.status, 304);
      assert.equal(await response.text(), "");
      assert.equal(response.headers.get("cache-control"), "no-cache");
      assert.equal(response.headers.get("etag"), '"lod-1"');
      const seen = requests.at(-1);
      assert.equal(seen.feed, "terrain");
      assert.equal(seen.path, configuration.terrain.lod_url);
      assert.equal(seen.method, method);
      assert.equal(seen.headers["if-none-match"], '"lod-1"');
      assert.equal(seen.headers.cookie, undefined);
      assert.equal(seen.headers.authorization, undefined);
    }
    const count = requests.length;
    for (const [path, method, status] of [
      [configuration.players.url, "POST", 405],
      [configuration.terrain.url, "POST", 405],
      ["/api/ingest", "GET", 404],
      [configuration.terrain.url + "?url=http://example.test", "GET", 404],
      [configuration.terrain.lod_url, "POST", 405],
      [configuration.terrain.lod_url, "PUT", 405],
      [configuration.terrain.lod_url, "DELETE", 405],
      [configuration.terrain.lod_url + "?url=http://example.test", "GET", 404],
      [configuration.terrain.lod_url + "/", "GET", 404],
      [
        configuration.terrain.lod_url.replace(
          "independent-world",
          "other-world",
        ),
        "GET",
        404,
      ],
      [
        configuration.terrain.lod_url.replace("lod.json", "%6cod.json"),
        "GET",
        404,
      ],
      [configuration.terrain.lod_url.replace("lod.json", "ingest"), "GET", 404],
    ])
      assert.equal((await fetch(viewer + path, { method })).status, status);
    assert.equal(requests.length, count);
    const redirect = await listen((req, res) =>
      res.writeHead(302, { Location: players }).end(),
    );
    const rejectRedirect = mapProxy({
      origin: redirect,
      terrainOrigin: redirect,
      world: "world",
      generation: "generation",
      fingerprint: "a".repeat(64),
    });
    const redirectViewer = await listen((req, res) => {
      void rejectRedirect(req, res, () => res.writeHead(404).end());
    });
    assert.equal(
      (await fetch(redirectViewer + "/api/v1/worlds/world/players")).status,
      503,
    );
    for (const method of ["GET", "HEAD"])
      assert.equal(
        (
          await fetch(
            redirectViewer + "/api/v1/worlds/world/terrain/lod.json",
            { method },
          )
        ).status,
        503,
      );
    assert.equal(requests.length, count);
  } finally {
    for (const server of servers) await new Promise((ok) => server.close(ok));
  }
});
