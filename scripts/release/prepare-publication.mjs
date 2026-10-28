import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { checkCurrentTag, currentCommit } from "./validate-tag.mjs";

const repository = "omdaniel/bedrock-surface-map";

export function assertPublicationRun(run, commit) {
  assert.equal(
    run.repository?.full_name,
    repository,
    "candidate repository mismatch",
  );
  assert.equal(
    run.path,
    ".github/workflows/deployment.yml",
    "candidate must come from Deployment Packaging",
  );
  assert.equal(
    run.event,
    "push",
    "candidate must be a main push, not a pull request",
  );
  assert.equal(run.head_branch, "main", "candidate must be built on main");
  assert.equal(
    run.head_sha,
    commit,
    "candidate must match the checked-out release tag",
  );
  assert.equal(run.status, "completed", "candidate workflow is still running");
  assert.equal(
    run.conclusion,
    "success",
    "all deployment gates must pass before publication",
  );
}

export function publicationArtifacts(artifacts, commit) {
  const names = [
    "oci-combined",
    "generated-amd64",
    "generated-arm64",
    "native-amd64",
    "native-arm64",
  ].map((name) => `deployment-${name}-${commit}`);
  for (const name of names) {
    const matching = artifacts.filter((a) => a.name === name && !a.expired);
    assert.equal(matching.length, 1, `need one unexpired artifact: ${name}`);
    assert.equal(
      matching[0].workflow_run?.head_sha,
      commit,
      "artifact source mismatch",
    );
  }
  return names;
}

async function main() {
  const { values } = parseArgs({
    options: { run: { type: "string" }, output: { type: "string" } },
    strict: true,
    allowPositionals: false,
  });
  if (!/^[1-9]\d{0,14}$/.test(values.run ?? "") || !values.output)
    throw Error(
      "usage: prepare-publication.mjs --run <successful-main-run-id> --output <new-directory>",
    );
  await checkCurrentTag(true);
  const commit = currentCommit();
  const call = (command, args, json = false) => {
    const result = execFileSync(command, args, {
      encoding: "utf8",
      stdio: json ? "pipe" : "inherit",
      timeout: 300_000,
      maxBuffer: 4 * 1024 ** 2,
    });
    return json ? JSON.parse(result) : undefined;
  };
  const api = (path) =>
    call("gh", ["api", `repos/${repository}/${path}`], true);
  const run = api(`actions/runs/${values.run}`);
  assertPublicationRun(run, commit);
  const listing = api(`actions/runs/${values.run}/artifacts?per_page=100`);
  assert.ok(listing.total_count <= 100, "unexpected artifact inventory size");
  const names = publicationArtifacts(listing.artifacts, commit);
  const output = resolve(values.output);
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output); // Never reuse output from an earlier publication attempt.
  const input = join(output, "input");
  await mkdir(input);
  call("gh", [
    "run",
    "download",
    values.run,
    "--repo",
    repository,
    ...names.flatMap((name) => ["--name", name]),
    "--dir",
    input,
  ]);
  const oci = join(input, `deployment-oci-combined-${commit}`);
  for (const arch of ["amd64", "arm64"])
    await copyFile(
      join(
        input,
        `deployment-generated-${arch}-${commit}`,
        "generated-evidence.json",
      ),
      join(oci, `generated-${arch}.json`),
    );
  const dist = join(output, "dist");
  call(process.execPath, [
    "ci/collect-release.mjs",
    dist,
    ...["amd64", "arm64"].map((arch) =>
      join(input, `deployment-native-${arch}-${commit}`),
    ),
  ]);
  call(process.execPath, [
    "scripts/release/publish.mjs",
    "--dist",
    dist,
    "--deployment",
    oci,
  ]);
  await writeFile(
    join(output, "source-run.json"),
    JSON.stringify(
      {
        schema_version: 1,
        commit,
        run_id: run.id,
        run_attempt: run.run_attempt,
        url: run.html_url,
        artifacts: names,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  console.log(JSON.stringify({ ok: true, commit, dist, oci }));
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
)
  await main();
