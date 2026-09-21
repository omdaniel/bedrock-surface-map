import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const target = args[0] ?? "x86_64-unknown-linux-musl";
const commonIndex = args.indexOf("--common");
const suppliedCommon = commonIndex < 0 ? null : args[commonIndex + 1];
if (commonIndex >= 0 && !suppliedCommon)
  throw Error("--common requires a directory");
if (
  execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
    encoding: "utf8",
  }).trim()
)
  throw Error("release package requires a clean tracked checkout");
const stage = resolve(".local/release", target);
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true, mode: 0o700 });
const common = suppliedCommon
  ? resolve(suppliedCommon)
  : resolve(stage, "common");
if (!suppliedCommon)
  execFileSync(
    process.execPath,
    ["scripts/release/build-common-artifact.mjs", common],
    {
      stdio: "inherit",
    },
  );
if (
  !(await (async () => {
    try {
      return (
        (await readFile(resolve(common, "common-manifest.json"), "utf8"))
          .length > 0
      );
    } catch {
      return false;
    }
  })())
)
  throw Error("common artifact manifest is missing");
execFileSync(
  process.execPath,
  ["scripts/release/build-native.mjs", target, resolve(stage, "native")],
  { stdio: "inherit" },
);
execFileSync(
  process.execPath,
  [
    "scripts/release/assemble.mjs",
    target,
    resolve(stage, "native"),
    common,
    resolve(stage, "dist"),
  ],
  { stdio: "inherit" },
);
const dist = resolve(stage, "dist");
const version = JSON.parse(await readFile("package.json", "utf8")).version;
const source = resolve(dist, `bedrock-surface-map-v${version}-source.tar.gz`);
execFileSync(
  "git",
  ["archive", "--format=tar.gz", "--output", source, "HEAD"],
  {
    stdio: "inherit",
  },
);
const archives = (await readdir(dist)).filter((name) =>
  name.endsWith(".tar.gz"),
);
const sums = [];
for (const name of archives) {
  const digest = createHash("sha256")
    .update(await readFile(resolve(dist, name)))
    .digest("hex");
  sums.push(`${digest}  ${name}`);
}
await writeFile(resolve(dist, "SHA256SUMS"), sums.sort().join("\n") + "\n");
const release = archives.find((name) => name.includes("-linux-"));
if (!release) throw Error("platform archive missing");
execFileSync(
  process.execPath,
  ["scripts/release/audit.mjs", resolve(dist, release)],
  {
    stdio: "inherit",
  },
);
