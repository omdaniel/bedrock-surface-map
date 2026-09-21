import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

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

const result = { dry_run: !publish, dist, tag: expectedTag, archives };
if (!publish) {
  console.log(JSON.stringify(result));
  process.exit(0);
}

if (process.env.CI_COMMIT_TAG !== expectedTag) {
  throw Error(`publication requires protected tag ${expectedTag}`);
}
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
    ...expected.map((name) => resolve(dist, name)),
    resolve(dist, "SHA256SUMS"),
    "--title",
    `Bedrock Surface Map ${expectedTag}`,
    "--generate-notes",
  ],
  { stdio: "inherit" },
);
console.log(JSON.stringify({ ...result, dry_run: false, published: true }));
