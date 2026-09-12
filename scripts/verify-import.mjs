import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
const input = process.argv[2];
if (!input) throw new Error("Pass the offline .mcworld path");
const root = "web/public/maps/bedrock-survival/";
const before = JSON.parse(await readFile(root + "manifest.json", "utf8"));
const objects = [
  ...before.regions.map((r) => r.url),
  before.heights,
  before.atlas,
];
const times = await Promise.all(
  objects.map(async (p) => (await stat(root + p)).mtimeMs),
);
const original = createHash("sha256")
  .update(await readFile(input))
  .digest("hex");
const child = spawnSync(
  "target/release/surface-map",
  ["import", "--input", input],
  { encoding: "utf8" },
);
if (child.status !== 0) throw new Error(child.stderr);
const after = JSON.parse(await readFile(root + "manifest.json", "utf8"));
if (JSON.stringify(before) !== JSON.stringify(after))
  throw new Error("Repeated import changed the manifest");
for (let i = 0; i < objects.length; i++)
  if ((await stat(root + objects[i])).mtimeMs !== times[i])
    throw new Error("Identical object rewritten");
if (
  createHash("sha256")
    .update(await readFile(input))
    .digest("hex") !== original
)
  throw new Error("Source archive changed");
const report = {
  ...JSON.parse(child.stdout),
  identical_objects_reused: objects.length,
};
await mkdir(".local/verification", { recursive: true });
await writeFile(
  ".local/verification/import.json",
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
