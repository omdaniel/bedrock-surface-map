import { mkdir, stat, rename, readFile } from "node:fs/promises";
import { createWriteStream, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
const source = JSON.parse(await readFile("sources/mojang.json", "utf8"));
const commit = source.commit;
const path = ".local/assets/bedrock-samples.zip";
async function verify(file) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  if (hash.digest("hex") !== source.archive_sha256)
    throw new Error(
      "Mojang archive checksum mismatch. Do not use this download; review the pinned source.",
    );
}
await mkdir(".local/assets", { recursive: true, mode: 0o700 });
let exists = false;
try {
  exists = (await stat(path)).size > 0;
} catch {}
if (exists) {
  await verify(path);
  console.log("Pinned asset archive verified.");
  process.exit(0);
}
console.log(
  "Downloading Mojang samples. Assets remain subject to the Minecraft EULA; see THIRD_PARTY.md.",
);
const response = await fetch(
  `https://codeload.github.com/Mojang/bedrock-samples/zip/${commit}`,
);
if (!response.ok || !response.body)
  throw new Error(`Asset download: ${response.status}`);
await pipeline(
  Readable.fromWeb(response.body),
  createWriteStream(`${path}.part`, { mode: 0o600 }),
);
await verify(`${path}.part`);
await rename(`${path}.part`, path);
