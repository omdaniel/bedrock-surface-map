import { readFile, readdir, lstat } from "node:fs/promises";
import { resolve, relative } from "node:path";
import assert from "node:assert/strict";
import { decodePacket, digest } from "./demo-packet.mjs";
import { verifyLodGraph } from "./release/verify-common.mjs";
const root = resolve(".local/demo-dist");
const pin = JSON.parse(await readFile("sources/demo.json", "utf8"));
const expected = decodePacket(
  await readFile(".local/demo-release/coastal-showcase-v1.json.gz"),
  pin.sha256,
);
const derived = new Set();
const stageNames = [0, 1, 2, 3].map((n) => `lod-stage-${n}.json`);
for (const [stage, name] of stageNames.entries()) {
  const base = new URL("http://127.0.0.1/showcase/");
  const graph = await verifyLodGraph(
    await readFile(resolve(root, "showcase", name)),
    base,
    (ref) => readFile(resolve(root, "showcase", ref.url)),
  );
  const source = JSON.parse(expected.get(`stage-${stage}.json`));
  assert.equal(graph.manifest.world_id, source.world_id);
  assert.equal(graph.manifest.generation, source.generation);
  assert.equal(graph.manifest.source_sha256, source.source_sha256);
  assert.equal(graph.manifest.revision, source.revision);
  assert.deepEqual(graph.manifest.bounds, source.bounds);
  assert.equal(graph.manifest.atlas.sha256, source.atlas.sha256);
  const materials = JSON.parse(expected.get(source.catalog.url));
  assert.deepEqual(graph.materials, materials);
  derived.add(name);
  for (const file of graph.files) derived.add(file);
}
let total = 0,
  count = 0;
async function visit(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = resolve(dir, entry.name),
      name = relative(root, file);
    assert.ok(!(await lstat(file)).isSymbolicLink(), "No artifact symlinks");
    if (entry.isDirectory()) {
      await visit(file);
      continue;
    }
    assert.ok(
      /^(assets\/[A-Za-z0-9_.-]+\.(js|css|wasm)|index\.html|viewer-config\.json|demo-poster\.png|showcase\/(objects\/[a-f0-9]{64}\.(zst|png|json)|(?:lod-)?stage-[0-3]\.json|scenario\.json|NOTICE\.txt))$/.test(
        name,
      ),
      `Unapproved site file: ${name}`,
    );
    const bytes = await readFile(file);
    total += bytes.length;
    count++;
    if (name.startsWith("showcase/")) {
      const original = expected.get(name.slice(9));
      if (original) {
        assert.equal(digest(bytes), digest(original));
        expected.delete(name.slice(9));
      } else assert.ok(derived.has(name.slice(9)), `Unlisted object ${name}`);
      if (name.startsWith("showcase/objects/"))
        assert.equal(digest(bytes), name.slice(17, 81));
    }
    if (/\.(html|js|css|json|txt)$/.test(name)) {
      assert.ok(
        !/192\.168\.|10\.0\.0\.|LittleWhistle5|MsDelali|JammyPoet|PopCello|minecraftvm100|BEGIN .*PRIVATE KEY|eyJhbGci/.test(
          bytes.toString(),
        ),
        `Private marker in ${name}`,
      );
    }
  }
}
await visit(root);
assert.equal(expected.size, 0, "Missing reviewed demo data");
assert.ok(total < 16 * 1024 * 1024, "Static site size budget");
assert.equal(
  digest(await readFile(resolve(root, "demo-poster.png"))),
  digest(await readFile("docs/media/demo.png")),
);
const config = JSON.parse(
  await readFile(resolve(root, "viewer-config.json"), "utf8"),
);
assert.deepEqual(config, {
  players: null,
  demo: {
    scenario: "showcase/scenario.json",
    poster: "demo-poster.png",
    lod_stages: stageNames.map((name) => `showcase/${name}`),
  },
});
console.log(
  JSON.stringify({
    approvedFiles: count,
    totalBytes: total,
    packetSha256: pin.sha256,
    noPrivateBindings: true,
  }),
);
