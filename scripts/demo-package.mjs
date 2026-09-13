import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { encodePacket, decodePacket, digest } from "./demo-packet.mjs";
const input = process.argv[2] ?? ".local/public-showcase-v1";
const files = {};
for (const name of [
  "scenario.json",
  "NOTICE.txt",
  ...[0, 1, 2, 3].map((n) => `stage-${n}.json`),
  ...(await readdir(join(input, "objects"))).sort().map((n) => `objects/${n}`),
])
  files[name] = (await readFile(join(input, name))).toString("base64");
const bytes = encodePacket(files);
const sha = digest(bytes);
decodePacket(bytes, sha);
await mkdir(".local/demo-release", { recursive: true });
await writeFile(".local/demo-release/coastal-showcase-v1.json.gz", bytes);
console.log(
  JSON.stringify({
    sha256: sha,
    bytes: bytes.length,
    files: Object.keys(files).length,
  }),
);
