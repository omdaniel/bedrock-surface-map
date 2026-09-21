import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { checkCurrentTag, currentCommit } from "./validate-tag.mjs";

const args = process.argv.slice(2);
const publish = args.includes("--publish");
const distIndex = args.indexOf("--dist");
const dist = resolve(
  distIndex >= 0 ? args[distIndex + 1] : ".local/release/dist",
);
if (distIndex >= 0 && !args[distIndex + 1])
  throw Error("--dist requires a directory");

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const expectedTag = `v${packageJson.version}`;
await checkCurrentTag(publish);
const files = await readdir(dist);
const archives = files.filter((name) => name.endsWith(".tar.gz")).sort();
const expected = [
  `bedrock-surface-map-v${packageJson.version}-linux-arm64.tar.gz`,
  `bedrock-surface-map-v${packageJson.version}-linux-amd64.tar.gz`,
  `bedrock-surface-map-v${packageJson.version}-source.tar.gz`,
];
for (const name of expected) {
  if (!archives.includes(name))
    throw Error(`release candidate is missing ${name}`);
}
if (
  archives.length !== expected.length ||
  expected.some((name) => !archives.includes(name))
)
  throw Error("release candidate archive inventory is not exact");

const sumText = await readFile(resolve(dist, "SHA256SUMS"), "utf8");
const sums = new Map(
  sumText
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [digest, name] = line.split(/\s{2,}/);
      return [name, digest];
    }),
);
for (const name of archives) {
  const digest = createHash("sha256")
    .update(await readFile(resolve(dist, name)))
    .digest("hex");
  if (sums.get(name) !== digest) throw Error(`SHA256SUMS mismatch for ${name}`);
  if (name.includes("-linux-")) {
    execFileSync(
      process.execPath,
      ["scripts/release/audit.mjs", resolve(dist, name)],
      {
        stdio: "inherit",
      },
    );
  }
}
if (sums.size !== expected.length)
  throw Error("SHA256SUMS inventory is not exact");
const evidence = JSON.parse(
  await readFile(resolve(dist, "release-evidence.json"), "utf8"),
);
if (
  evidence.schema_version !== 1 ||
  evidence.commit !== currentCommit() ||
  !Array.isArray(evidence.targets) ||
  evidence.targets.length !== 2
)
  throw Error(
    "release candidate lacks source-bound native acceptance evidence",
  );
const expectedTargets = new Map([
  ["x86_64-unknown-linux-musl", "linux-x64"],
  ["aarch64-unknown-linux-musl", "linux-arm64"],
]);
for (const item of evidence.targets) {
  const host = expectedTargets.get(item.target);
  if (
    !host ||
    item.host !== host ||
    item.commit !== evidence.commit ||
    item.archive_sha256 !== sums.get(item.archive) ||
    item.repeat_assembly_sha256 !== item.archive_sha256 ||
    item.native_smoke?.ok !== true ||
    item.native_smoke?.generated_world_import == null ||
    item.native_smoke?.corruption_refused !== true ||
    item.browser_smoke?.ok !== true ||
    item.browser_smoke?.terrain_pixels !== true ||
    item.browser_smoke?.picking !== true ||
    JSON.stringify(item.browser_smoke?.mount_paths) !==
      JSON.stringify(["/", "/map/"])
  )
    throw Error(
      "release candidate has missing or inconsistent native test evidence",
    );
  expectedTargets.delete(item.target);
}
if (expectedTargets.size)
  throw Error("release candidate is missing a native target");
const sourceMember = execFileSync(
  "tar",
  ["-xOzf", resolve(dist, expected[2]), "package.json"],
  { encoding: "utf8" },
);
if (JSON.parse(sourceMember).version !== packageJson.version)
  throw Error("source archive version disagrees with candidate");

const result = { dry_run: !publish, dist, tag: expectedTag, archives };
if (!publish) {
  console.log(JSON.stringify(result));
  process.exit(0);
}

if (process.env.CI_COMMIT_TAG !== expectedTag) {
  throw Error(`publication requires protected tag ${expectedTag}`);
}
if (process.env.CI_COMMIT_REF_PROTECTED !== "true")
  throw Error("publication requires a protected tag pipeline");
if (process.env.CI_PIPELINE_SOURCE === "merge_request_event") {
  throw Error("publication is forbidden from merge-request pipelines");
}
if (process.env.BEDROCK_MAP_PUBLISH_APPROVED !== "true") {
  throw Error(
    "set BEDROCK_MAP_PUBLISH_APPROVED=true only in the protected release job",
  );
}
if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
  throw Error("publication requires a protected GitHub release token");
}

execFileSync(
  "gh",
  [
    "release",
    "create",
    expectedTag,
    "--repo",
    "omdaniel/bedrock-surface-map",
    ...expected.map((name) => resolve(dist, name)),
    resolve(dist, "SHA256SUMS"),
    resolve(dist, "release-evidence.json"),
    "--title",
    `Bedrock Surface Map ${expectedTag}`,
    "--generate-notes",
  ],
  { stdio: "inherit" },
);
console.log(JSON.stringify({ ...result, dry_run: false, published: true }));
