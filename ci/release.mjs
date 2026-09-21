import { execFileSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const target = process.argv[2];
const common = process.argv[3];
if (!target) throw Error("usage: node ci/release.mjs <rust-target>");
if (!common)
  throw Error("usage: node ci/release.mjs <rust-target> <common-artifact>");
const expectedArchitecture =
  target === "x86_64-unknown-linux-musl"
    ? "x64"
    : target === "aarch64-unknown-linux-musl"
      ? "arm64"
      : null;
if (process.platform !== "linux" || process.arch !== expectedArchitecture)
  throw Error(
    `native release gate requires Linux ${expectedArchitecture} for ${target}`,
  );
function checkedReport(script, args) {
  const output = execFileSync(process.execPath, [script, ...args], {
    encoding: "utf8",
  });
  const last = output.trim().split("\n").at(-1);
  const report = JSON.parse(last);
  if (report.ok !== true)
    throw Error(`${script} did not report a passing test`);
  return report;
}
execFileSync(
  "npm",
  ["run", "package:linux", "--", target, "--common", common],
  {
    stdio: "inherit",
  },
);
const reproducible = checkedReport("scripts/release/reproducible.mjs", [
  target,
  resolve(".local/release", target, "native"),
  resolve(common),
]);
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
const archivePath = resolve(dist, archive);
const archiveSha256 = createHash("sha256")
  .update(await readFile(archivePath))
  .digest("hex");
if (reproducible.sha256 !== archiveSha256)
  throw Error("repeat assembly differs from the tested archive");
const fixture = resolve(".local/release", target, "generated-fixture");
execFileSync(
  "cargo",
  [
    "test",
    "--locked",
    "-p",
    "surface-cli",
    "ci_generate_world_fixture",
    "--",
    "--ignored",
  ],
  {
    stdio: "inherit",
    env: { ...process.env, BEDROCK_MAP_FIXTURE_DIR: fixture },
  },
);
const nativeSmoke = checkedReport("scripts/release/smoke.mjs", [
  archivePath,
  "--world",
  resolve(fixture, "generated.mcworld"),
  "--assets",
  resolve(fixture, "assets.zip"),
]);
const browserSmoke = checkedReport("scripts/release/browser-smoke.mjs", [
  archivePath,
]);
const listing = execFileSync("tar", ["-tzf", archivePath], {
  encoding: "utf8",
}).split("\n");
const member = listing.find((name) => name.endsWith("/release-manifest.json"));
if (!member) throw Error("release manifest missing from tested archive");
const manifest = JSON.parse(
  execFileSync("tar", ["-xOzf", archivePath, member], { encoding: "utf8" }),
);
if (
  manifest.target !== target ||
  manifest.commit !==
    execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()
)
  throw Error("tested archive source identity mismatch");
const evidence = {
  schema_version: 1,
  target,
  commit: manifest.commit,
  archive,
  archive_sha256: archiveSha256,
  host: `${process.platform}-${process.arch}`,
  repeat_assembly_sha256: reproducible.sha256,
  native_smoke: nativeSmoke,
  browser_smoke: browserSmoke,
};
await writeFile(
  resolve(dist, `release-evidence-${target}.json`),
  JSON.stringify(evidence, null, 2) + "\n",
);
console.log(JSON.stringify({ ok: true, evidence }));
