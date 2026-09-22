import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import { assertBrowserEvidence } from "../scripts/release/evidence.mjs";
import { assertReleaseCommon } from "../scripts/release/verify-common.mjs";

const [destination, ...sources] = process.argv.slice(2);
if (!destination || sources.length < 2) {
  throw Error(
    "usage: node ci/collect-release.mjs <destination> <target-dist> <target-dist>",
  );
}
const output = resolve(destination);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const evidence = [];
for (const source of sources.map((source) => resolve(source))) {
  const evidenceName = (await readdir(source)).find((name) =>
    /^release-evidence-(x86_64|aarch64)-unknown-linux-musl\.json$/.test(name),
  );
  if (!evidenceName) throw Error(`native test evidence missing from ${source}`);
  evidence.push(
    JSON.parse(await readFile(resolve(source, evidenceName), "utf8")),
  );
  for (const name of await readdir(source)) {
    if (!name.endsWith(".tar.gz")) continue;
    const target = resolve(output, name);
    try {
      await copyFile(resolve(source, name), target, constants.COPYFILE_EXCL);
    } catch (error) {
      if (error.code === "EEXIST" && name.endsWith("-source.tar.gz")) {
        const existing = await readFile(target);
        const duplicate = await readFile(resolve(source, name));
        if (!existing.equals(duplicate))
          throw Error(`source archive differs between target jobs: ${name}`);
        continue;
      }
      throw error;
    }
  }
}
const sums = [];
const archives = (await readdir(output))
  .filter((name) => name.endsWith(".tar.gz"))
  .sort();
if (
  archives.length !== 3 ||
  archives.filter((name) => name.includes("-linux-")).length !== 2
)
  throw Error(
    "candidate must contain exactly two native and one source archive",
  );
for (const name of archives) {
  const digest = createHash("sha256")
    .update(await readFile(resolve(output, name)))
    .digest("hex");
  sums.push(`${digest}  ${name}`);
}
await writeFile(resolve(output, "SHA256SUMS"), sums.join("\n") + "\n");

const commonManifests = archives
  .filter((name) => name.includes("-linux-"))
  .map((name) => ({
    name,
    bytes: embeddedCommonManifest(resolve(output, name)),
  }));
if (commonManifests.length !== 2)
  throw Error("candidate must contain exactly two Linux architecture archives");
const [firstManifest, ...remainingManifests] = commonManifests;
for (const manifest of remainingManifests) {
  if (!firstManifest.bytes.equals(manifest.bytes))
    throw Error(
      `common resource manifest differs between ${firstManifest.name} and ${manifest.name}`,
    );
}
const common = JSON.parse(firstManifest.bytes);
if (common.schema_version !== 1 || !Array.isArray(common.files))
  throw Error("invalid common artifact manifest");
const byTarget = new Map();
for (const item of evidence) {
  const expectedArch =
    item.target === "x86_64-unknown-linux-musl"
      ? "linux-x64"
      : item.target === "aarch64-unknown-linux-musl"
        ? "linux-arm64"
        : null;
  if (
    !expectedArch ||
    byTarget.has(item.target) ||
    item.host !== expectedArch ||
    item.schema_version !== 1 ||
    item.commit !== common.commit ||
    item.native_smoke?.ok !== true ||
    item.native_smoke?.generated_world_import == null ||
    item.native_smoke?.corruption_refused !== true ||
    item.repeat_assembly_sha256 !== item.archive_sha256
  )
    throw Error("native release evidence is missing or inconsistent");
  const archive = resolve(output, item.archive);
  if (
    !archives.includes(item.archive) ||
    createHash("sha256")
      .update(await readFile(archive))
      .digest("hex") !== item.archive_sha256
  )
    throw Error("native evidence does not bind the candidate archive bytes");
  assertBrowserEvidence(item.browser_smoke, item.archive_sha256, item.commit);
  const releaseManifest = embeddedJson(archive, "/release-manifest.json");
  if (
    releaseManifest.commit !== item.commit ||
    releaseManifest.target !== item.target
  )
    throw Error("native release manifest disagrees with evidence");
  assertReleaseCommon(common, releaseManifest);
  byTarget.set(item.target, item);
}
if (byTarget.size !== 2)
  throw Error("both native target evidence files are required");
await writeFile(
  resolve(output, "release-evidence.json"),
  JSON.stringify(
    {
      schema_version: 1,
      commit: common.commit,
      targets: [...byTarget.values()].sort((a, b) =>
        a.target.localeCompare(b.target),
      ),
    },
    null,
    2,
  ) + "\n",
);
await writeFile(
  resolve(output, "COMMON_RESOURCES_SHA256"),
  `${createHash("sha256").update(firstManifest.bytes).digest("hex")}  provenance/common-manifest.json\n`,
);

function embeddedCommonManifest(archive) {
  const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
    .split("\n")
    .filter((entry) => entry.endsWith("/provenance/common-manifest.json"));
  if (entries.length !== 1)
    throw Error(`${archive} must contain exactly one common resource manifest`);
  return execFileSync("tar", ["-xOzf", archive, entries[0]]);
}
function embeddedJson(archive, suffix) {
  const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
    .split("\n")
    .filter((entry) => entry.endsWith(suffix));
  if (entries.length !== 1)
    throw Error(`${archive} must contain exactly one ${suffix}`);
  return JSON.parse(
    execFileSync("tar", ["-xOzf", archive, entries[0]], { encoding: "utf8" }),
  );
}
