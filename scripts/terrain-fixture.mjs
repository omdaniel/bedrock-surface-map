import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
const options = process.argv.slice(2);
if (options.some((option) => option !== "--small-only"))
  throw Error("Usage: node scripts/terrain-fixture.mjs [--small-only]");
const output = resolve(".local/terrain-fixture");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const map = resolve(output, "map");
await cp("web/public/maps/fixture", map, { recursive: true });
const manifest = JSON.parse(
  await readFile(resolve(map, "manifest.json"), "utf8"),
);
// The legacy fixture has a label here; LOD requires a real source fingerprint.
if (!/^[a-f0-9]{64}$/.test(manifest.source_sha256))
  manifest.source_sha256 = createHash("sha256")
    .update(manifest.source_sha256)
    .digest("hex");
for (const m of manifest.materials.slice(1)) {
  m.name =
    m.name.toLowerCase() === "grass" ? "grass_block" : m.name.toLowerCase();
  m.key = JSON.stringify([`minecraft:${m.name}`, {}]);
}
await writeFile(resolve(map, "manifest.json"), JSON.stringify(manifest));
const state = resolve(output, "state");
const run = (...args) =>
  execFileSync(
    "cargo",
    [
      "run",
      "--quiet",
      "--locked",
      "-p",
      "surface-sync",
      "--",
      "--state",
      state,
      "--world",
      "fixture-world",
      "--generation",
      "fixture-generation",
      ...args,
    ],
    { encoding: "utf8" },
  );
const snapshot = async (stage) => {
  await writeFile(resolve(output, `root-${stage}.json`), run("manifest"));
  execFileSync(
    "cargo",
    [
      "run",
      "--quiet",
      "--locked",
      "-p",
      "surface-sync",
      "--example",
      "lod_fixture",
      "--",
      state,
      resolve(output, `lod-${stage}.json`),
    ],
    { stdio: "inherit" },
  );
};
run("seed", "--map", map);
await snapshot(0);
const base = {
  schema_version: 1,
  rules_version: 1,
  world_id: "fixture-world",
  generation: "fixture-generation",
  producer: "fixture-producer",
  started_ms: 1000,
  scan_start_ms: 1000,
  scan_end_ms: 1001,
  materials: [
    { name: "surface:unknown", states: {} },
    { name: "minecraft:sand", states: {} },
  ],
  diagnostics: {
    queued: 0,
    pending_bytes: 0,
    oldest_scan_ms: 0,
    reads: 0,
    errors: 0,
    overflow: 0,
  },
};
for (const [sequence, cx, cz, height] of [
  [1, -8, -8, 256],
  [2, 64, 0, 80],
  [3, 256, 256, 160],
]) {
  const observation = {
    ...base,
    sequence,
    chunks: [
      {
        cx,
        cz,
        columns: Array.from({ length: 256 }, () => [
          1,
          height,
          1,
          0x91bd59,
          1,
          0,
          -32768,
          0,
          1,
          height,
        ]),
      },
    ],
  };
  const path = resolve(output, "observation.json");
  await writeFile(path, JSON.stringify(observation));
  run("observe", "--input", path);
  await snapshot(sequence);
}
console.log(`Synthetic live terrain and LOD fixtures: ${output}`);
if (!options.includes("--small-only"))
  execFileSync(
    "cargo",
    [
      "run",
      "--quiet",
      "--locked",
      "-p",
      "surface-sync",
      "--example",
      "large_fixture",
    ],
    { stdio: "inherit" },
  );
