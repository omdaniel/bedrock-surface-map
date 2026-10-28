import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { publicationTag, validateTag } from "./validate-tag.mjs";

const base = {
  version: "0.1.0",
  sourceCommit: "a".repeat(40),
  tagCommit: "a".repeat(40),
};

test("provider tag selection accepts GitHub tags and rejects branch and PR refs", () => {
  for (const ref of [
    "refs/heads/main",
    "refs/pull/19/merge",
    "refs/tags/v1.0/extra",
  ])
    assert.equal(
      publicationTag({
        GITHUB_ACTIONS: "true",
        GITHUB_REF: ref,
        CI_COMMIT_TAG: "v0.1.0",
      }),
      undefined,
    );
  assert.equal(
    publicationTag({ GITHUB_ACTIONS: "true", GITHUB_REF: "refs/tags/v0.1.1" }),
    "v0.1.1",
  );
  assert.equal(publicationTag({ CI_COMMIT_TAG: "v0.1.0" }), "v0.1.0");
});

test("matching, mismatching, missing, and wrong-commit tags", () => {
  assert.equal(
    validateTag({ ...base, tag: "v0.1.0", required: true }),
    "v0.1.0",
  );
  assert.throws(
    () => validateTag({ ...base, tag: "v0.1.1", required: true }),
    /does not match/,
  );
  assert.throws(
    () => validateTag({ ...base, tag: undefined, required: true }),
    /requires protected tag/,
  );
  assert.throws(
    () =>
      validateTag({
        ...base,
        tag: "v0.1.0",
        tagCommit: "b".repeat(40),
        required: true,
      }),
    /does not point/,
  );
});

test("GitLab publication invokes the repository-owned validator", async () => {
  const yaml = await readFile(".gitlab-ci.yml", "utf8");
  assert.match(yaml, /- node scripts\/release\/validate-tag\.mjs --required/);
  assert.doesNotMatch(yaml, /node -p \\"require/);
  const result = spawnSync(
    process.execPath,
    ["scripts/release/validate-tag.mjs", "--required"],
    {
      encoding: "utf8",
      env: { ...process.env, CI_COMMIT_TAG: "", CI_COMMIT_SHA: "" },
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires protected tag/);
});
