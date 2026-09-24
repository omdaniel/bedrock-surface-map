import assert from "node:assert/strict";

// Synthetic observations use the public producer contracts and real ingest
// listeners. Nothing is intercepted in the browser or written into the store.
export function generatedProducer({ host, ports, tokens, world, generation }) {
  const started = Date.now();
  let playerSequence = 0,
    terrainSequence = 0;
  const send = async (name, body, token = tokens[name]) => {
    const response = await fetch(
      `http://${host}:${ports[name]}/ingest/v1/${name === "players" ? "snapshot" : "terrain"}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [name === "players" ? "x-tracker-token" : "x-terrain-token"]: token,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      },
    );
    await response.arrayBuffer();
    return response.status;
  };
  const players = (x, heading) => ({
    schema_version: 1,
    world_id: world,
    instance_id: "browser-fixture",
    started_at_ms: started,
    sampled_at_ms: Date.now(),
    sequence: ++playerSequence,
    pack_version: "fixture",
    players:
      x === null
        ? []
        : [
            {
              id: "fictional-player",
              name: "Fixture Explorer",
              dimension: "minecraft:overworld",
              position: { x, y: 65, z: -8.5, heading },
              discontinuity: true,
            },
          ],
  });
  const terrain = (material, height) => ({
    schema_version: 1,
    rules_version: 1,
    world_id: world,
    generation,
    producer: "browser-fixture",
    started_ms: started,
    scan_start_ms: Date.now(),
    scan_end_ms: Date.now(),
    sequence: ++terrainSequence,
    materials: [
      { name: "surface:unknown", states: {} },
      { name: `minecraft:${material}`, states: {} },
    ],
    chunks: [
      {
        cx: -1,
        cz: -1,
        columns: Array.from({ length: 256 }, () => [
          1,
          height * 16,
          1,
          0x91bd59,
          1,
          0,
          -32768,
          0,
          1,
          height * 16,
        ]),
      },
    ],
  });
  return {
    async players(x, heading = 0) {
      assert.equal(await send("players", players(x, heading)), 204);
    },
    async terrain(material, height) {
      assert.equal(await send("terrain", terrain(material, height)), 204);
    },
    async negativeChecks() {
      for (const [name, body] of [
        ["players", players(null, 0)],
        ["terrain", { ...terrain("grass", 65), chunks: [] }],
      ]) {
        assert.equal(await send(name, body, "wrong"), 401);
        assert.equal(
          await send(name, { ...body, world_id: "wrong-world" }),
          name === "players" ? 422 : 400,
        );
        assert.equal(await send(name, body), 204);
        assert.equal(await send(name, body), name === "players" ? 422 : 409);
      }
    },
  };
}
