import { execFileSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

const target = process.argv[2];
if (!target) throw Error("usage: node ci/release.mjs <rust-target>");
execFileSync("npm", ["run", "package:linux", "--", target], {
  stdio: "inherit",
});
const version = JSON.parse(
  await (await import("node:fs/promises")).readFile("package.json", "utf8"),
).version;
const dist = resolve(".local/release", target, "dist");
const archiveArchitecture =
  target === "x86_64-unknown-linux-musl" ? "amd64" : "arm64";
const archive = (await readdir(dist)).find(
  (name) =>
    name ===
    `bedrock-surface-map-v${version}-linux-${archiveArchitecture}.tar.gz`,
);
if (!archive) throw Error(`could not locate ${target} archive`);
execFileSync(
  process.execPath,
  ["scripts/release/smoke.mjs", resolve(dist, archive)],
  {
    stdio: "inherit",
  },
);
console.log(
  JSON.stringify({
    target,
    archive: resolve(dist, archive),
    native_smoke: true,
  }),
);
