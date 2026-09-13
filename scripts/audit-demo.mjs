import { readFile, readdir, lstat } from "node:fs/promises";
import { resolve, relative } from "node:path";
import assert from "node:assert/strict";
import { decodePacket, digest } from "./demo-packet.mjs";
const root = resolve(".local/demo-dist");
const pin = JSON.parse(await readFile("sources/demo.json", "utf8"));
const expected = decodePacket(
  await readFile(".local/demo-release/coastal-showcase-v1.json.gz"),
  pin.sha256,
);
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
      /^(assets\/[A-Za-z0-9_.-]+\.(js|css|wasm)|index\.html|viewer-config\.json|demo-poster\.png|showcase\/(objects\/[a-f0-9]{64}\.(zst|png|json)|stage-[0-3]\.json|scenario\.json|NOTICE\.txt))$/.test(
        name,
      ),
      `Unapproved site file: ${name}`,
    );
    const bytes = await readFile(file);
    total += bytes.length;
    count++;
    if (name.startsWith("showcase/")) {
      const original = expected.get(name.slice(9));
      assert.ok(original, `Unlisted object ${name}`);
      assert.equal(digest(bytes), digest(original));
      expected.delete(name.slice(9));
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
  demo: { scenario: "showcase/scenario.json", poster: "demo-poster.png" },
});
console.log(
  JSON.stringify({
    approvedFiles: count,
    totalBytes: total,
    packetSha256: pin.sha256,
    noPrivateBindings: true,
  }),
);
