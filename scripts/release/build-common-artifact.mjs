import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";

const output = resolve(process.argv[2] ?? ".local/release/common");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true, mode: 0o700 });
execFileSync(process.execPath, ["scripts/release/build-common.mjs", output], {
  stdio: "inherit",
});
execFileSync(
  "cargo",
  [
    "run",
    "--release",
    "--locked",
    "-p",
    "surface-cli",
    "--",
    "fixture",
    "--output",
    resolve(output, "fixture"),
  ],
  { stdio: "inherit" },
);
execFileSync("npm", ["run", "terrain:build"], { stdio: "inherit" });
execFileSync("npm", ["run", "tracking:build"], { stdio: "inherit" });
await cp(".local/terrain/pack", resolve(output, "terrain-pack"), {
  recursive: true,
});
await cp(".local/tracking/pack", resolve(output, "tracking-pack"), {
  recursive: true,
});
const files = [];
async function inventory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await inventory(path);
    else if (entry.isFile()) {
      const bytes = await readFile(path);
      files.push({
        path: relative(output, path).replaceAll("\\", "/"),
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
      });
    } else throw Error(`common artifact contains unsupported entry: ${path}`);
  }
}
await inventory(output);
const commit = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
await writeFile(
  resolve(output, "common-manifest.json"),
  JSON.stringify(
    {
      schema_version: 1,
      commit,
      files: files.sort((a, b) => a.path.localeCompare(b.path)),
    },
    null,
    2,
  ) + "\n",
);
console.log(JSON.stringify({ output, commit, files: files.length }));
