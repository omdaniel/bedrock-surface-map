import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve, sep } from "node:path";
import { verificationConfig } from "./verification-config.mjs";
const config = verificationConfig({
  options: {
    input: { type: "string" },
    "map-dir": { type: "string" },
    assets: { type: "string" },
    cli: { type: "string", default: "target/release/surface-map" },
  },
});
if (!config.input || !config["map-dir"])
  throw Error(
    "Configure input archive and map-dir for repeat-import verification",
  );
const input = config.input;
const root = resolve(config["map-dir"]) + sep;
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
  config.cli,
  [
    "import",
    "--input",
    input,
    "--output",
    root,
    "--name",
    before.name,
    ...(config.assets ? ["--assets", config.assets] : []),
  ],
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
await mkdir(config.output, { recursive: true });
await writeFile(
  resolve(config.output, "import.json"),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
