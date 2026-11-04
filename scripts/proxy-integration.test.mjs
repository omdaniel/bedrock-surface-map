import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mapProxy } from "./map-proxy.mjs";

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
      requests.push({ feed, path: req.url, headers: req.headers });
      if (req.headers["if-none-match"] === '"synthetic-etag"') {
        res.writeHead(304, { ETag: '"synthetic-etag"' }).end();
        return;
      }
      res
        .writeHead(200, {
          "Content-Type": "application/json",
          ETag: '"synthetic-etag"',
        })
        .end(JSON.stringify({ feed }));
    };
    const players = await listen(reader("players")),
      terrain = await listen(reader("terrain"));
    const proxy = mapProxy({
      origin: players,
      terrainOrigin: terrain,
      terrainLod: true,
      world: "independent-world",
      generation: "independent-generation",
      fingerprint: "a".repeat(64),
      map: "maps/fixture/manifest.json",
    });
    const viewer = await listen((req, res) => {
      void proxy(req, res, () => res.writeHead(404).end());
    });
    const configuration = await (
      await fetch(viewer + "/viewer-config.json")
    ).json();
    assert.equal(configuration.map, "maps/fixture/manifest.json");
    for (const [path, feed] of [
      [configuration.players.url, "players"],
      [configuration.terrain.url, "terrain"],
      [configuration.lod_url, "terrain"],
      [
        configuration.terrain.url.replace(
          "manifest.json",
          `objects/${"a".repeat(64)}.json`,
        ),
        "terrain",
      ],
    ]) {
      const response = await fetch(viewer + path, {
        headers: {
          Cookie: "private=fixture",
          Authorization: "Bearer fixture",
          "X-Terrain-Token": "private-fixture",
        },
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).feed, feed);
      const seen = requests.at(-1);
      assert.equal(seen.headers.cookie, undefined);
      assert.equal(seen.headers.authorization, undefined);
      assert.equal(seen.headers["x-terrain-token"], undefined);
      assert.equal(
        (await fetch(viewer + path, { method: "HEAD" })).status,
        200,
      );
    }
    const revalidated = await fetch(viewer + configuration.lod_url, {
      headers: { "If-None-Match": '"synthetic-etag"' },
    });
    assert.equal(revalidated.status, 304);
    assert.equal(revalidated.headers.get("etag"), '"synthetic-etag"');
    assert.equal(revalidated.headers.get("cache-control"), "no-cache");
    const count = requests.length;
    for (const [path, method, status] of [
      [configuration.players.url, "POST", 405],
      [configuration.terrain.url, "POST", 405],
      [configuration.lod_url, "PUT", 405],
      [configuration.lod_url + "?url=http://example.test", "GET", 404],
      [
        configuration.lod_url.replace("independent-world", "another-world"),
        "GET",
        404,
      ],
      ["/api/ingest", "GET", 404],
      [configuration.terrain.url + "?url=http://example.test", "GET", 404],
    ])
      assert.equal((await fetch(viewer + path, { method })).status, status);
    assert.equal(requests.length, count);
    const redirect = await listen((req, res) =>
      res.writeHead(302, { Location: players }).end(),
    );
    const rejectRedirect = mapProxy({
      origin: redirect,
      world: "world",
      fingerprint: "a".repeat(64),
    });
    const redirectViewer = await listen((req, res) => {
      void rejectRedirect(req, res, () => res.writeHead(404).end());
    });
    assert.equal(
      (await fetch(redirectViewer + "/api/v1/worlds/world/players")).status,
      503,
    );
    assert.equal(requests.length, count);
  } finally {
    for (const server of servers) await new Promise((ok) => server.close(ok));
  }
});
