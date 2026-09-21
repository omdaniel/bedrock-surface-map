import { execFileSync } from "node:child_process";
import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const target = process.argv[2] ?? "x86_64-unknown-linux-musl";
const stage = resolve(".local/release", target);
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true, mode: 0o700 });
execFileSync(process.execPath, ["scripts/release/build-common.mjs", resolve(stage, "common")], { stdio: "inherit" });
execFileSync("cargo", ["run", "--release", "--locked", "-p", "surface-cli", "--", "fixture", "--output", resolve(stage, "common/fixture")], { stdio: "inherit" });
execFileSync("npm", ["run", "terrain:build"], { stdio: "inherit" });
execFileSync("npm", ["run", "tracking:build"], { stdio: "inherit" });
await cp(".local/terrain/pack", resolve(stage, "common/terrain-pack"), { recursive: true });
await cp(".local/tracking/pack", resolve(stage, "common/tracking-pack"), { recursive: true });
execFileSync(process.execPath, ["scripts/release/build-native.mjs", target, resolve(stage, "native")], { stdio: "inherit" });
execFileSync(process.execPath, ["scripts/release/assemble.mjs", target, resolve(stage, "native"), resolve(stage, "common"), resolve(stage, "dist")], { stdio: "inherit" });
