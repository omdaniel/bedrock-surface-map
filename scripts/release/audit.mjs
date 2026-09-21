import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const archive = process.argv[2];
if (!archive) throw Error("usage: audit.mjs <archive>");
const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
  .trim()
  .split("\n");
const forbidden =
  /(^|\/)(\.git|\.env[^/]*|\.local|node_modules|target)(\/|$)|\.(mcworld|ldb)$/i;
for (const entry of entries)
  if (forbidden.test(entry))
    throw Error(`release contains forbidden path: ${entry}`);
if (entries.some((entry) => /\/packs\/.*probe/i.test(entry)))
  throw Error("release contains a diagnostic probe pack");
const staging = await mkdtemp(join(tmpdir(), "bedrock-map-audit-"));
try {
  execFileSync("tar", ["-xzf", archive, "-C", staging], { stdio: "inherit" });
  const root = entries
    .find((entry) => entry.endsWith("/release-manifest.json"))
    ?.replace(/release-manifest\.json$/, "");
  if (!root) throw Error("release manifest missing");
  const manifest = JSON.parse(
    await readFile(join(staging, root, "release-manifest.json"), "utf8"),
  );
  if (manifest.schema_version !== 1 || !Array.isArray(manifest.files))
    throw Error("unsupported release manifest");
  for (const file of manifest.files) {
    if (!file.path || file.path.includes("..") || file.path.startsWith("/"))
      throw Error("unsafe manifest path");
    const bytes = await readFile(join(staging, root, file.path));
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== file.sha256 || bytes.length !== file.bytes)
      throw Error(`release manifest mismatch: ${file.path}`);
  }
  console.log(
    JSON.stringify({ ok: true, archive, files: manifest.files.length }),
  );
} finally {
  await rm(staging, { recursive: true, force: true });
}
