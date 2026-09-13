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
      res
        .writeHead(200, { "Content-Type": "application/json" })
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
      void proxy(req, res, () => res.writeHead(404).end());
    });
    const configuration = await (
      await fetch(viewer + "/viewer-config.json")
    ).json();
    assert.equal(configuration.map, "maps/fixture/manifest.json");
    for (const [path, feed] of [
      [configuration.players.url, "players"],
      [configuration.terrain.url, "terrain"],
    ]) {
      const response = await fetch(viewer + path, {
        headers: { Cookie: "private=fixture", Authorization: "Bearer fixture" },
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).feed, feed);
      const seen = requests.at(-1);
      assert.equal(seen.headers.cookie, undefined);
      assert.equal(seen.headers.authorization, undefined);
      assert.equal(
        (await fetch(viewer + path, { method: "HEAD" })).status,
        200,
      );
    }
    const count = requests.length;
    for (const [path, method, status] of [
      [configuration.players.url, "POST", 405],
      [configuration.terrain.url, "POST", 405],
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
