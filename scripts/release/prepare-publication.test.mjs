import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertPublicationRun,
  publicationArtifacts,
} from "./prepare-publication.mjs";

const commit = "a".repeat(40);
const run = {
  repository: { full_name: "omdaniel/bedrock-surface-map" },
  path: ".github/workflows/deployment.yml",
  event: "push",
  head_branch: "main",
  head_sha: commit,
  status: "completed",
  conclusion: "success",
};

test("publication accepts only successful deployment artifacts from the exact main commit", () => {
  assertPublicationRun(run, commit);
  for (const change of [
    { repository: { full_name: "someone/fork" } },
    { event: "pull_request" },
    { path: ".github/workflows/ci.yml" },
    { head_branch: "codex/change" },
    { head_sha: "b".repeat(40) },
    { status: "in_progress" },
    { conclusion: "failure" },
  ])
    assert.throws(() => assertPublicationRun({ ...run, ...change }, commit));
});

test("publication refuses expired, missing, ambiguous and wrong-source artifacts", () => {
  const artifacts = [
    "oci-combined",
    "generated-amd64",
    "generated-arm64",
    "native-amd64",
    "native-arm64",
  ].map((name) => ({
    name: `deployment-${name}-${commit}`,
    expired: false,
    workflow_run: { head_sha: commit },
  }));
  assert.equal(publicationArtifacts(artifacts, commit).length, 5);
  assert.throws(() => publicationArtifacts(artifacts.slice(1), commit));
  assert.throws(() =>
    publicationArtifacts([...artifacts, artifacts[0]], commit),
  );
  for (const change of [
    { expired: true },
    { workflow_run: { head_sha: "b".repeat(40) } },
  ]) {
    const altered = structuredClone(artifacts);
    Object.assign(altered[0], change);
    assert.throws(() => publicationArtifacts(altered, commit));
  }
});
