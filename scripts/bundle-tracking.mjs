import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const output = resolve(".local/tracking/bundle");
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
if (git("status", "--porcelain"))
  throw Error("Bundle only a clean, committed application checkout");
const commit = git("rev-parse", "HEAD");
execFileSync(process.execPath, ["scripts/build-tracking.mjs"], {
  stdio: "inherit",
});
const sysroot = execFileSync("rustc", ["--print", "sysroot"], {
  encoding: "utf8",
}).trim();
const host = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(
  /^host: (.+)$/m,
)?.[1];
if (!host) throw Error("Cannot determine Rust host toolchain");
execFileSync(
  "cargo",
  [
    "build",
    "--release",
    "--locked",
    "--target",
    "x86_64-unknown-linux-musl",
    "-p",
    "surface-tracker",
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER: resolve(
        sysroot,
        "lib/rustlib",
        host,
        "bin/rust-lld",
      ),
    },
  },
);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true, mode: 0o700 });
await cp(".local/tracking/pack", resolve(output, "pack"), { recursive: true });
await cp(".local/tracking/probe", resolve(output, "probe"), {
  recursive: true,
});
await cp(
  "target/x86_64-unknown-linux-musl/release/surface-tracker",
  resolve(output, "surface-tracker"),
);
const files = {};
for (const path of [
  "surface-tracker",
  "pack/manifest.json",
  "pack/scripts/core.js",
  "pack/scripts/config.js",
  "pack/scripts/main.js",
  "probe/manifest.json",
  "probe/scripts/main.js",
])
  files[path] = createHash("sha256")
    .update(await readFile(resolve(output, path)))
    .digest("hex");
await writeFile(
  resolve(output, "artifact.json"),
  JSON.stringify(
    {
      schema_version: 1,
      application_commit: commit,
      target: "x86_64-unknown-linux-musl",
      files,
    },
    null,
    2,
  ) + "\n",
);
console.log(`Verified-commit bundle: ${output}`);
