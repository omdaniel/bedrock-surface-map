import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
const output = resolve(".local/terrain-fixture");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const map = resolve(output, "map");
await cp("web/public/maps/fixture", map, { recursive: true });
const manifest = JSON.parse(
  await readFile(resolve(map, "manifest.json"), "utf8"),
);
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
run("seed", "--map", map);
await writeFile(resolve(output, "root-0.json"), run("manifest"));
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
  await writeFile(resolve(output, `root-${sequence}.json`), run("manifest"));
}
console.log(`Synthetic live terrain fixtures: ${output}`);
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
