import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  BDS,
  requireDisposable,
  validatePackagingRun,
} from "./crafty-contract.mjs";

export async function verifyInputs(env = process.env) {
  requireDisposable(env);
  const compatibility = JSON.parse(
    await readFile("tracking/compatibility.json", "utf8"),
  );
  assert.equal(compatibility.bds_version, BDS.version);
  assert.equal(compatibility.bds_zip_sha256, BDS.sha256);
  assert.match(env.CRAFTY_PACKAGING_RUN_ID ?? "", /^[1-9][0-9]{0,19}$/);
  assert.match(
    env.GITHUB_REPOSITORY ?? "",
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
  );
  assert.ok(
    env.GITHUB_TOKEN,
    "read-only Actions token required to verify artifact provenance",
  );
  const response = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/runs/${env.CRAFTY_PACKAGING_RUN_ID}`,
    {
      headers: {
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    },
  );
  assert.equal(response.status, 200, "cannot verify packaging run");
  const body = await response.text();
  assert.ok(body.length < 1024 ** 2);
  validatePackagingRun(
    JSON.parse(body),
    env.GITHUB_REPOSITORY,
    env.CRAFTY_SOURCE_SHA,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await verifyInputs();
  console.log(
    "Exact successful Deployment Packaging run and manual BDS/EULA opt-in verified.",
  );
}
