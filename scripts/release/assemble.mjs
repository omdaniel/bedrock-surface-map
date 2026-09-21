import { execFileSync } from "node:child_process";
import {
  chmod,
  cp,
  mkdir,
  readdir,
  readFile,
  rm,
  rename,
  utimes,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, relative } from "node:path";
import { verifyCommon } from "./verify-common.mjs";

const [target, nativeArg, commonArg, outputArg] = process.argv.slice(2);
if (!target || !nativeArg || !commonArg || !outputArg)
  throw Error("usage: assemble.mjs <target> <native> <common> <output>");
const native = resolve(nativeArg),
  common = resolve(commonArg),
  output = resolve(outputArg);
const version = JSON.parse(await readFile("package.json", "utf8")).version;
const commit = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
await verifyCommon(common, commit);
const epoch = Number(
  execFileSync("git", ["show", "-s", "--format=%ct", "HEAD"], {
    encoding: "utf8",
  }).trim(),
);
if (!Number.isSafeInteger(epoch) || epoch <= 0)
  throw Error("invalid source commit timestamp");
const architecture = target.startsWith("x86_64")
  ? "amd64"
  : target.startsWith("aarch64")
    ? "arm64"
    : (() => {
        throw Error(`unsupported target ${target}`);
      })();
const rootName = `bedrock-surface-map-v${version}-linux-${architecture}`;
const root = resolve(output, rootName);
await rm(root, { recursive: true, force: true });
await mkdir(resolve(root, "libexec"), { recursive: true, mode: 0o755 });
await mkdir(resolve(root, "share/bedrock-surface-map/fixtures"), {
  recursive: true,
  mode: 0o755,
});
await mkdir(resolve(root, "share/bedrock-surface-map/packs"), {
  recursive: true,
  mode: 0o755,
});
await mkdir(resolve(root, "share/bedrock-surface-map/provenance"), {
  recursive: true,
  mode: 0o755,
});
for (const binary of [
  "bedrock-map",
  "surface-map",
  "surface-sync",
  "surface-tracker",
])
  await cp(
    resolve(native, binary),
    resolve(root, binary === "bedrock-map" ? binary : `libexec/${binary}`),
  );
for (const binary of [
  "bedrock-map",
  "surface-map",
  "surface-sync",
  "surface-tracker",
])
  await chmod(
    resolve(root, binary === "bedrock-map" ? binary : `libexec/${binary}`),
    0o755,
  );
await cp(
  resolve(common, "web"),
  resolve(root, "share/bedrock-surface-map/web"),
  { recursive: true },
);
await cp(
  resolve(common, "fixture"),
  resolve(root, "share/bedrock-surface-map/fixtures/surface-v1"),
  { recursive: true },
);
await cp(
  resolve(common, "terrain-pack"),
  resolve(root, "share/bedrock-surface-map/packs/terrain"),
  { recursive: true },
);
await cp(
  resolve(common, "tracking-pack"),
  resolve(root, "share/bedrock-surface-map/packs/tracking"),
  { recursive: true },
);
await cp(
  "sources/mojang.json",
  resolve(root, "share/bedrock-surface-map/provenance/mojang.json"),
);
await cp(
  resolve(common, "common-manifest.json"),
  resolve(root, "share/bedrock-surface-map/provenance/common-manifest.json"),
);
for (const file of ["LICENSE", "THIRD_PARTY.md"])
  await cp(file, resolve(root, file));
await mkdir(resolve(root, "docs"), { recursive: true });
for (const file of ["INSTALL.md", "CI.md"])
  await cp(resolve("docs", file), resolve(root, "docs", file));
await cp("CONTRIBUTING.md", resolve(root, "docs/CONTRIBUTING.md"));
await cp("sources/build-tools.json", resolve(root, "docs/build-tools.json"));
await writeFile(
  resolve(root, "BUILDING.txt"),
  `The matching bedrock-surface-map-v${version}-source.tar.gz archive contains the complete source and lockfiles.\n` +
    `Check out commit ${commit} and follow docs/GETTING_STARTED.md and docs/CI.md in that source archive.\n` +
    `The pinned developer prerequisites are listed in docs/build-tools.json here and sources/build-tools.json in source.\n` +
    `Dependency and asset notices are in THIRD_PARTY.md and share/bedrock-surface-map/provenance/.\n`,
);
await writeFile(
  resolve(root, "README.txt"),
  `Bedrock Surface Map snapshot runtime\n\n` +
    `1. ./bedrock-map init --state ./map-data\n` +
    `2. ./bedrock-map demo --state ./map-data\n` +
    `3. ./bedrock-map serve --state ./map-data\n\n` +
    `Inspect the installed state with:\n` +
    `./bedrock-map status --state ./map-data\n` +
    `./bedrock-map doctor --state ./map-data --json\n\n` +
    `The service prints a loopback URL. To import an offline .mcworld, fetch assets explicitly:\n` +
    `./bedrock-map assets fetch --state ./map-data --acknowledge-asset-terms\n` +
    `Then run ./bedrock-map import --state ./map-data --input /path/to/world.mcworld --name "My World" --replace-active\n`,
);
const files = await inventory(root);
await writeFile(
  resolve(root, "release-manifest.json"),
  JSON.stringify(
    { schema_version: 1, application_version: version, commit, target, files },
    null,
    2,
  ) + "\n",
);
await mkdir(output, { recursive: true });
const archive = resolve(output, `${rootName}.tar.gz`);
await normalizeMtime(root, epoch);
const rawArchive = `${archive}.tar`;
const tarArgs =
  process.platform === "darwin"
    ? ["-C", output, "-cf", rawArchive, rootName]
    : [
        "-C",
        output,
        "--sort=name",
        `--mtime=@${epoch}`,
        "--owner=0",
        "--group=0",
        "--numeric-owner",
        "--format=posix",
        "--pax-option=delete=atime,delete=ctime",
        "-cf",
        rawArchive,
        rootName,
      ];
execFileSync("tar", tarArgs, { stdio: "inherit" });
execFileSync("gzip", ["-n", "-f", rawArchive], { stdio: "inherit" });
await rename(`${rawArchive}.gz`, archive);
console.log(JSON.stringify({ archive, target, files: files.length }));

async function inventory(root) {
  const records = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const bytes = await readFile(path);
        records.push({
          path: relative(root, path).replaceAll("\\", "/"),
          sha256: createHash("sha256").update(bytes).digest("hex"),
          bytes: bytes.length,
        });
      }
    }
  }
  await walk(root);
  return records.sort((left, right) => left.path.localeCompare(right.path));
}

async function normalizeMtime(path, timestamp) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) await normalizeMtime(child, timestamp);
    else if (!entry.isFile())
      throw Error(`unsupported release entry: ${child}`);
    await utimes(child, timestamp, timestamp);
  }
  await utimes(path, timestamp, timestamp);
}
