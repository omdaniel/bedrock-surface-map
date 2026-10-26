import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { checkSteps, invocation } from "./commands.mjs";

test("check defaults to fast and accepts only complete, known options", () => {
  assert.equal(invocation(["check"]).values.profile, "fast");
  assert.equal(
    invocation(["check", "--profile", "full"]).values.profile,
    "full",
  );
  for (const args of [
    ["check", "--profile"],
    ["check", "--profile", "typo"],
    ["check", "--offline"],
    ["check", "full"],
    ["package"],
    ["package", "--target"],
    ["package", "--target", "invalid"],
    ["demo", "--install-hooks"],
    ["demo", "--port", "80"],
    ["demo", "--port", "1.5"],
    ["demo", "--port", "65536"],
    ["setup", "--", "unexpected"],
  ])
    assert.throws(() => invocation(args), args.join(" "));
});

test("browser test options pass through an explicit separator", () => {
  const result = invocation([
    "test",
    "--",
    "tests/dial.spec.ts",
    "--grep",
    "keyboard",
  ]);
  assert.deepEqual(result.tail, ["tests/dial.spec.ts", "--grep", "keyboard"]);
  assert.throws(() => invocation(["test", "--grep", "keyboard"]));
});

test("help and malformed invocations do not start a build", () => {
  for (const args of [
    ["--help"],
    ["package", "--help"],
    ["check", "--profile", "typo"],
  ]) {
    const result = spawnSync(process.execPath, ["scripts/dev.mjs", ...args], {
      encoding: "utf8",
      env: { ...process.env, PATH: "" },
    });
    assert.equal(result.status, args.includes("typo") ? 2 : 0, result.stderr);
    assert.doesNotMatch(result.stderr, /spawn|ENOENT|cargo exited/);
    if (result.status === 0) assert.match(result.stdout, /Usage: \.\/dev/);
  }
});

test("full verification prepares all browser data and includes public-demo acceptance", () => {
  const plan = checkSteps("full").map((step) => step.join(" "));
  const browser = plan.indexOf("npx --no-install playwright test");
  assert.ok(browser > 0);
  for (const fixture of [
    "web/public/maps/fixture",
    "web/public/maps/coast",
    "scripts/terrain-fixture.mjs",
  ])
    assert.ok(
      plan.slice(0, browser).some((step) => step.includes(fixture)),
      fixture,
    );
  assert.equal(plan.filter((step) => step === "npm run build").length, 1);
  assert.ok(plan.includes("node scripts/check-demo.mjs"));
  assert.ok(plan.includes("node scripts/audit-demo.mjs"));
  assert.ok(
    !checkSteps("fast").some((step) =>
      /playwright|demo:build/.test(step.join(" ")),
    ),
  );
});
