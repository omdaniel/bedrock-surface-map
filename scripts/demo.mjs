import { readFile, writeFile, mkdir, rm, cp } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { decodePacket, digest } from "./demo-packet.mjs";
const command = process.argv[2] ?? "prepare";
const source = JSON.parse(await readFile("sources/demo.json", "utf8"));
const cache = resolve(".local/demo-release/coastal-showcase-v1.json.gz");
let bytes;
try {
  bytes = await readFile(cache);
} catch {}
if (!bytes || digest(bytes) !== source.sha256) {
  const response = await fetch(source.url, {
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok || !response.body)
    throw Error(`Demo download failed: ${response.status}`);
  const parts = [];
  let size = 0;
  for await (const part of response.body) {
    size += part.length;
    if (size > 16 * 1024 * 1024) throw Error("Demo download exceeds limit");
    parts.push(part);
  }
  bytes = Buffer.concat(parts);
}
const files = decodePacket(bytes, source.sha256);
await mkdir(dirname(cache), { recursive: true });
await writeFile(cache, bytes);
const publicDir = resolve(".local/demo-public");
await rm(publicDir, { recursive: true, force: true });
for (const [name, data] of files) {
  const path = resolve(publicDir, "showcase", name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
}
await writeFile(
  resolve(publicDir, "viewer-config.json"),
  JSON.stringify({
    players: null,
    demo: { scenario: "showcase/scenario.json", poster: "demo-poster.png" },
  }),
);
try {
  await cp("docs/media/demo.png", resolve(publicDir, "demo-poster.png"));
} catch (error) {
  if (command === "build")
    throw Error("Capture the reviewed demo poster before a release build", {
      cause: error,
    });
}
const env = {
  ...process.env,
  VITE_SURFACE_DEMO: "true",
  SURFACE_BASE_PATH: process.env.SURFACE_BASE_PATH ?? "/bedrock-surface-map/",
  SURFACE_DEMO_PUBLIC: publicDir,
  SURFACE_DEMO_DIST: resolve(".local/demo-dist"),
};
for (const name of [
  "SURFACE_PLAYERS_ORIGIN",
  "SURFACE_WORLD_ID",
  "SURFACE_FINGERPRINT",
  "SURFACE_TERRAIN_ORIGIN",
  "SURFACE_GENERATION",
])
  delete env[name];
const run = (cmd, args) => {
  const result = spawnSync(cmd, args, { stdio: "inherit", env });
  if (result.status !== 0) process.exit(result.status ?? 1);
};
console.log(
  `Verified public demo: ${files.size} files; ${bytes.length} packet bytes`,
);
if (command === "dev")
  run("npx", [
    "vite",
    "--config",
    "vite.config.ts",
    "--port",
    "5180",
    "--strictPort",
  ]);
else if (command === "build") {
  await rm(resolve(".local/demo-dist"), { recursive: true, force: true });
  run("npm", ["run", "build"]);
} else if (command !== "prepare") throw Error("Expected prepare, dev or build");
