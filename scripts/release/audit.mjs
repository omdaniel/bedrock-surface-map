import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const archive = process.argv[2];
if (!archive) throw Error("usage: audit.mjs <archive>");
const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
  .trim()
  .split("\n");
const forbidden =
  /(^|\/)(\.git|\.env[^/]*|\.local|node_modules|target|worlds|db|secrets|config\.toml|import-report\.json)(\/|$)|\.(mcworld|ldb|zip)$/i;
const root = entries.find((entry) =>
  /^bedrock-surface-map-v[^/]+-linux-(amd64|arm64)\/$/.test(entry),
);
if (!root) throw Error("archive has no expected release root");
if (new Set(entries).size !== entries.length)
  throw Error("release contains duplicate archive entries");
for (const entry of entries) {
  if (
    !entry.startsWith(root) ||
    entry.includes("\\") ||
    entry.split("/").some((part) => part === "." || part === "..") ||
    /[\x00-\x1f]/.test(entry) ||
    forbidden.test(entry)
  )
    throw Error(`release contains forbidden path: ${entry}`);
}
const verbose = execFileSync("tar", ["-tvzf", archive], { encoding: "utf8" })
  .trim()
  .split("\n");
if (
  verbose.length !== entries.length ||
  verbose.some((line) => !["-", "d"].includes(line[0]))
)
  throw Error("release contains a link or unsupported archive entry");
if (entries.some((entry) => /\/packs\/.*probe/i.test(entry)))
  throw Error("release contains a diagnostic probe pack");
const staging = await mkdtemp(join(tmpdir(), "bedrock-map-audit-"));
try {
  execFileSync("tar", ["-xzf", archive, "-C", staging], { stdio: "inherit" });
  const manifest = JSON.parse(
    await readFile(join(staging, root, "release-manifest.json"), "utf8"),
  );
  if (manifest.schema_version !== 1 || !Array.isArray(manifest.files))
    throw Error("unsupported release manifest");
  if (
    !/^[0-9a-f]{40}$/.test(manifest.commit) ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(
      manifest.application_version,
    ) ||
    !["x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl"].includes(
      manifest.target,
    )
  )
    throw Error("invalid release identity");
  if (
    !root.includes(`v${manifest.application_version}-linux-`) ||
    !root.endsWith(manifest.target.startsWith("x86_64") ? "amd64/" : "arm64/")
  )
    throw Error("release archive name and manifest disagree");
  const declared = new Set();
  for (const file of manifest.files) {
    if (
      !file.path ||
      file.path.startsWith("/") ||
      file.path.includes("\\") ||
      file.path
        .split("/")
        .some((part) => !part || part === "." || part === "..") ||
      forbidden.test(file.path) ||
      declared.has(file.path) ||
      !/^[0-9a-f]{64}$/.test(file.sha256) ||
      !Number.isSafeInteger(file.bytes)
    )
      throw Error("unsafe manifest path");
    declared.add(file.path);
    const bytes = await readFile(join(staging, root, file.path));
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== file.sha256 || bytes.length !== file.bytes)
      throw Error(`release manifest mismatch: ${file.path}`);
  }
  const actual = new Set();
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink())
        throw Error(`release contains a symlink: ${path}`);
      if (metadata.isDirectory()) await walk(path);
      else if (metadata.isFile()) {
        const relative = path
          .slice(join(staging, root).length + 1)
          .replaceAll("\\", "/");
        if (relative !== "release-manifest.json") actual.add(relative);
      } else throw Error(`release contains an unsupported entry: ${path}`);
    }
  }
  await walk(join(staging, root));
  if (
    actual.size !== declared.size ||
    [...actual].some((path) => !declared.has(path))
  )
    throw Error("release archive contains unlisted or missing content");
  for (const required of [
    "bedrock-map",
    "README.txt",
    "BUILDING.txt",
    "LICENSE",
    "THIRD_PARTY.md",
    "docs/INSTALL.md",
    "docs/CI.md",
    "docs/CONTRIBUTING.md",
    "docs/build-tools.json",
    "share/bedrock-surface-map/provenance/common-manifest.json",
  ])
    if (!declared.has(required)) throw Error(`release is missing ${required}`);
  console.log(
    JSON.stringify({ ok: true, archive, files: manifest.files.length }),
  );
} finally {
  await rm(staging, { recursive: true, force: true });
}
