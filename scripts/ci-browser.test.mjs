import assert from "node:assert/strict";
import { test } from "node:test";
import base from "../playwright.config.ts";
import config from "./ci-browser.config.mjs";
import { assertExactPartition, testIdentities } from "./check-ci-shards.mjs";

test("CI shards preserve browser assertions, timeouts and one-worker resource isolation", () => {
  assert.equal(config.testMatch, base.testMatch);
  assert.equal(config.timeout, base.timeout);
  assert.equal(config.expect, base.expect);
  assert.equal(config.retries, base.retries);
  assert.equal(config.workers, 1);
  assert.equal(config.fullyParallel, true);
  const softwareGpu =
    Boolean(process.env.CI) || process.env.SURFACE_CI_LOCAL_SOFTWARE === "1";
  assert.deepEqual(
    config.use.viewport,
    softwareGpu ? { width: 960, height: 720 } : base.use.viewport,
  );
  assert.equal(config.use.deviceScaleFactor, base.use.deviceScaleFactor);
  if (process.env.SURFACE_CI_LOCAL_SOFTWARE !== "1")
    assert.deepEqual(config.use, {
      ...base.use,
      viewport: config.use.viewport,
    });
  assert.equal(config.reporter[0][0], "line");
  assert.equal(config.reporter[1][0], "json");
});

test("shard audit rejects omissions, duplicates, unexpected tests and empty discovery", () => {
  assertExactPartition(["a", "b", "c"], [["b"], ["a", "c"]]);
  for (const shards of [
    [["a"], ["b"]],
    [
      ["a", "b"],
      ["b", "c"],
    ],
    [["a", "b"], ["d"]],
    [["a", "b", "c"], []],
  ])
    assert.throws(() => assertExactPartition(["a", "b", "c"], shards));
  assert.throws(() => assertExactPartition([], []));
  assert.throws(() => assertExactPartition(["a", "a"], [["a"], ["a"]]));
});

test("discovery identity preserves suite ancestry and browser projects", () => {
  const spec = {
    file: "a.spec.ts",
    title: "same title",
    tests: [{ projectName: "chromium" }, { projectName: "other" }],
  };
  const report = {
    suites: [
      {
        title: "a.spec.ts",
        suites: [
          { title: "one", specs: [spec] },
          { title: "two", specs: [spec] },
        ],
      },
    ],
  };
  const ids = testIdentities(report);
  assert.equal(ids.length, 4);
  assert.equal(new Set(ids).size, 4);
});
