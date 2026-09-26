import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function testIdentities(report) {
  const identities = [];
  function visit(suite, ancestors = []) {
    const path = [...ancestors, suite.title];
    for (const spec of suite.specs ?? [])
      for (const test of spec.tests)
        identities.push(
          JSON.stringify([spec.file, ...path, spec.title, test.projectName]),
        );
    for (const child of suite.suites ?? []) visit(child, path);
  }
  for (const suite of report.suites) visit(suite);
  return identities;
}

export function assertExactPartition(complete, shards) {
  assert(complete.length > 0, "browser discovery must not be empty");
  assert.equal(
    new Set(complete).size,
    complete.length,
    "duplicate test identity",
  );
  assert(
    shards.every((shard) => shard.length > 0),
    "empty browser shard",
  );
  const combined = shards.flat();
  assert.equal(new Set(combined).size, combined.length, "test assigned twice");
  assert.deepEqual(
    [...combined].sort(),
    [...complete].sort(),
    "browser shards must include every discovered test exactly once",
  );
}

export function checkCiShards(count = 3) {
  assert(
    Number.isInteger(count) && count > 0 && count <= 8,
    "invalid shard count",
  );
  const root = fileURLToPath(new URL("../", import.meta.url));
  const cli = resolve(root, "node_modules/@playwright/test/cli.js");
  const list = (shard) => {
    const env = { ...process.env };
    for (const key of [
      "PLAYWRIGHT_JSON_OUTPUT_FILE",
      "PLAYWRIGHT_JSON_OUTPUT_DIR",
      "PLAYWRIGHT_JSON_OUTPUT_NAME",
    ])
      delete env[key];
    return testIdentities(
      JSON.parse(
        execFileSync(
          process.execPath,
          [
            cli,
            "test",
            "--config",
            "scripts/ci-browser.config.mjs",
            "--list",
            "--reporter=json",
            ...(shard ? [`--shard=${shard}/${count}`] : []),
          ],
          {
            cwd: root,
            env,
            encoding: "utf8",
            timeout: 60_000,
            maxBuffer: 8 << 20,
          },
        ),
      ),
    );
  };
  const complete = list();
  const shards = Array.from({ length: count }, (_, i) => list(i + 1));
  assertExactPartition(complete, shards);
  return {
    tests: complete.length,
    shards: shards.map((shard) => shard.length),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  console.log(JSON.stringify(checkCiShards(Number(process.argv[2] ?? 3))));
