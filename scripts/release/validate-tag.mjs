import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function validateTag({
  tag,
  version,
  sourceCommit,
  tagCommit,
  required,
}) {
  const expected = `v${version}`;
  if (!tag) {
    if (required) throw Error(`publication requires protected tag ${expected}`);
    return expected;
  }
  if (tag !== expected)
    throw Error(`tag ${tag} does not match package version ${expected}`);
  if (tagCommit !== sourceCommit)
    throw Error("release tag does not point to the candidate source commit");
  return expected;
}

export function currentCommit() {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
}

export function checkedTagCommit(tag) {
  return execFileSync("git", ["rev-parse", `refs/tags/${tag}^{commit}`], {
    encoding: "utf8",
  }).trim();
}

export function publicationTag(env = process.env) {
  return env.GITHUB_ACTIONS === "true"
    ? env.GITHUB_REF?.match(/^refs\/tags\/(v[^/]+)$/)?.[1]
    : env.CI_COMMIT_TAG;
}

export async function checkCurrentTag(required = false) {
  const version = JSON.parse(await readFile("package.json", "utf8")).version;
  const sourceCommit = currentCommit();
  const ciCommit =
    process.env.GITHUB_ACTIONS === "true"
      ? process.env.GITHUB_EVENT_NAME === "workflow_dispatch"
        ? process.env.GITHUB_SHA
        : undefined
      : process.env.CI_COMMIT_SHA;
  if (ciCommit && ciCommit !== sourceCommit)
    throw Error("CI source commit disagrees with the checkout");
  const tag = publicationTag();
  return validateTag({
    tag,
    version,
    sourceCommit,
    tagCommit: tag ? checkedTagCommit(tag) : undefined,
    required,
  });
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  const tag = await checkCurrentTag(process.argv.includes("--required"));
  console.log(JSON.stringify({ ok: true, tag, commit: currentCommit() }));
}
