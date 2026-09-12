import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
const run = (cmd, args, options = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", ...options });
if (run("git", ["status", "--porcelain"]).trim())
  throw Error("Bundle only a clean committed checkout");
const commit = run("git", ["rev-parse", "HEAD"]).trim();
if (!run("cargo-zigbuild", ["--version"]).includes("0.20.1"))
  throw Error("cargo-zigbuild 0.20.1 required");
const zig = process.env.CARGO_ZIGBUILD_ZIG_PATH ?? "python-zig";
if (run(zig, ["version"]).trim() !== "0.15.2")
  throw Error("Zig 0.15.2 required");
run(
  "cargo",
  [
    "zigbuild",
    "--release",
    "--locked",
    "--target",
    "x86_64-unknown-linux-musl",
    "-p",
    "surface-sync",
    "-p",
    "surface-cli",
  ],
  { stdio: "inherit", env: { ...process.env, CARGO_ZIGBUILD_ZIG_PATH: zig } },
);
run(process.execPath, ["scripts/build-terrain.mjs"], { stdio: "inherit" });
const output = resolve(".local/terrain/bundle");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true, mode: 0o700 });
for (const name of ["pack", "probe"])
  await cp(`.local/terrain/${name}`, `${output}/${name}`, { recursive: true });
for (const name of ["surface-sync", "surface-cli"])
  await cp(
    `target/x86_64-unknown-linux-musl/release/${name === "surface-cli" ? "surface-map" : name}`,
    `${output}/${name}`,
  );
run(
  "cargo",
  [
    "run",
    "--quiet",
    "--release",
    "--locked",
    "-p",
    "surface-cli",
    "--",
    "fixture",
    "--output",
    `${output}/seed`,
  ],
  { stdio: "inherit" },
);
const seed = JSON.parse(await readFile(`${output}/seed/manifest.json`, "utf8"));
for (const m of seed.materials.slice(1)) {
  m.name =
    m.name.toLowerCase() === "grass" ? "grass_block" : m.name.toLowerCase();
  m.key = JSON.stringify([`minecraft:${m.name}`, {}]);
}
await writeFile(`${output}/seed/manifest.json`, JSON.stringify(seed));
const files = {};
async function walk(path = "") {
  for (const e of await readdir(`${output}/${path}`, { withFileTypes: true })) {
    const relative = path + e.name;
    if (e.isDirectory()) await walk(relative + "/");
    else
      files[relative] = createHash("sha256")
        .update(await readFile(`${output}/${relative}`))
        .digest("hex");
  }
}
await walk();
await writeFile(
  `${output}/artifact.json`,
  JSON.stringify(
    {
      schema_version: 1,
      application_commit: commit,
      target: "x86_64-unknown-linux-musl",
      rust: "1.92.0",
      zig: "0.15.2",
      cargo_zigbuild: "0.20.1",
      files,
    },
    null,
    2,
  ) + "\n",
);
console.log(`Verified-commit terrain bundle: ${output}`);
