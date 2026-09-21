import { execFileSync } from "node:child_process";
import {
  chmod,
  cp,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, relative } from "node:path";

const [target, nativeArg, commonArg, outputArg] = process.argv.slice(2);
if (!target || !nativeArg || !commonArg || !outputArg)
  throw Error("usage: assemble.mjs <target> <native> <common> <output>");
const native = resolve(nativeArg),
  common = resolve(commonArg),
  output = resolve(outputArg);
const version = JSON.parse(await readFile("package.json", "utf8")).version;
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
await cp("sources/mojang.json", resolve(root, "share/bedrock-surface-map/provenance/mojang.json"));
for (const file of ["LICENSE", "THIRD_PARTY.md"])
  await cp(file, resolve(root, file));
await writeFile(
  resolve(root, "README.txt"),
  "Bedrock Surface Map snapshot runtime. See docs/INSTALL.md in the source archive.\n",
);
const files = await inventory(root);
const commit = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
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
const tarArgs =
  process.platform === "darwin"
    ? ["-C", output, "-czf", archive, rootName]
    : [
        "-C",
        output,
        "--sort=name",
        "--owner=0",
        "--group=0",
        "--numeric-owner",
        "-czf",
        archive,
        rootName,
      ];
execFileSync("tar", tarArgs, { stdio: "inherit" });
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
