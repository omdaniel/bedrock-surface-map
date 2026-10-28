import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  acceptanceCommits,
  classifyPanelLogs,
  sanitizePanelState,
} from "./crafty-run.mjs";
import {
  BDS,
  CRAFTY,
  assertEmptyLive,
  bedrockImport,
  enableDisposableBetaApis,
  inspectBdsLogs,
  requireDisposable,
  validatePackagingRun,
} from "./crafty-contract.mjs";

const authorized = {
  GITHUB_ACTIONS: "true",
  RUNNER_ENVIRONMENT: "github-hosted",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  CRAFTY_DOWNLOAD_BDS: "true",
  CRAFTY_ACCEPT_MINECRAFT_EULA: "true",
  CRAFTY_SOURCE_SHA: "a".repeat(40),
};
test("panel diagnostics classify failures without preserving credential canaries", () => {
  const secret = "SYNTHETIC-NOT-FOR-EVIDENCE";
  const state = sanitizePanelState({
    State: {
      Status: "exited",
      Running: false,
      ExitCode: 1,
      Error: `Permission denied ${secret}`,
    },
    Config: { Env: [`PASSWORD=${secret}`] },
    Image: CRAFTY.amd64_config,
    RestartCount: 0,
  });
  assert.equal(state.running, false);
  assert.equal(state.engine_error_classifications.permission_errors, 1);
  const logs = classifyPanelLogs(
    `Password: ${secret}\nTraceback (most recent call last)\nConnection refused`,
  );
  assert.equal(logs.python_tracebacks, 1);
  assert.equal(logs.network_errors, 1);
  assert.ok(!JSON.stringify({ state, logs }).includes(secret));
});
test("application identity stays distinct from the harness checkout", async () => {
  const original = process.cwd();
  const expectedHarness = acceptanceCommits().harness_commit;
  const candidate = await mkdtemp(join(tmpdir(), "crafty-candidate-"));
  try {
    execFileSync("git", ["init", "--quiet", candidate]);
    execFileSync("git", [
      "-C",
      candidate,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "synthetic candidate",
    ]);
    const expected = execFileSync(
      "git",
      ["-C", candidate, "rev-parse", "HEAD"],
      { encoding: "utf8" },
    ).trim();
    process.chdir(candidate);
    assert.deepEqual(acceptanceCommits(), {
      commit: expected,
      harness_commit: expectedHarness,
    });
    assert.notEqual(expected, expectedHarness);
  } finally {
    process.chdir(original);
    await rm(candidate, { recursive: true, force: true });
  }
});
test("game download requires manual hosted Linux AMD64 and independent EULA opt-in", () => {
  requireDisposable(authorized, "linux", "x64");
  for (const key of Object.keys(authorized))
    assert.throws(() =>
      requireDisposable({ ...authorized, [key]: "" }, "linux", "x64"),
    );
  for (const [key, value] of [
    ["GITHUB_EVENT_NAME", "pull_request"],
    ["RUNNER_ENVIRONMENT", "self-hosted"],
  ])
    assert.throws(() =>
      requireDisposable({ ...authorized, [key]: value }, "linux", "x64"),
    );
  assert.throws(() => requireDisposable(authorized, "darwin", "x64"));
  assert.throws(() => requireDisposable(authorized, "linux", "arm64"));
});
test("pins match repository compatibility target and official origins", async () => {
  const pin = JSON.parse(
    await readFile(
      new URL("../../tracking/compatibility.json", import.meta.url),
    ),
  );
  assert.equal(BDS.version, pin.bds_version);
  assert.equal(BDS.sha256, pin.bds_zip_sha256);
  assert.equal(new URL(BDS.url).origin, "https://www.minecraft.net");
  assert.match(
    CRAFTY.image,
    /^registry\.gitlab\.com\/crafty-controller\/crafty-4@sha256:[a-f0-9]{64}$/,
  );
  assert.match(CRAFTY.amd64, /^sha256:[a-f0-9]{64}$/);
});
test("packaging provenance refuses stale source, wrong repo, workflow or unsuccessful jobs", () => {
  const run = {
    repository: { full_name: "example/app" },
    path: ".github/workflows/deployment.yml",
    name: "Deployment Packaging",
    status: "completed",
    conclusion: "success",
    head_sha: "a".repeat(40),
  };
  validatePackagingRun(run, "example/app", "a".repeat(40));
  for (const patch of [
    { conclusion: "failure" },
    { conclusion: null },
    { status: "in_progress" },
    { head_sha: "b".repeat(40) },
    { path: ".github/workflows/other.yml" },
    { repository: { full_name: "attacker/app" } },
  ])
    assert.throws(() =>
      validatePackagingRun({ ...run, ...patch }, "example/app", "a".repeat(40)),
    );
});
test("pinned API import uses verified local ZIP and actual executable without an implicit download", () => {
  const body = bedrockImport();
  assert.equal(body.minecraft_bedrock_create_data.create_type, "import_server");
  assert.equal(
    body.minecraft_bedrock_create_data.import_server_create_data.command,
    "./bedrock_server",
  );
  assert.equal(body.autostart, false);
  assert.equal(
    body.minecraft_bedrock_create_data.download_exe_create_data,
    undefined,
  );
});

function sample(sequence = 1) {
  return [
    {
      world_id: "fresh",
      status: "live",
      age_ms: 10,
      snapshot: {
        instance_id: "actual-bds",
        sequence,
        sampled_at_ms: sequence * 5000,
        pack_version: "1.0.4",
        players: [],
      },
    },
    {
      world_id: "fresh",
      status: "live",
      sample_age_ms: 20,
      diagnostics: {
        errors: 0,
        scan_errors: 0,
        send_errors: 0,
        completed: 0,
        active_chunks: 0,
        overflow: 0,
      },
    },
  ];
}
test("empty-server acceptance requires recurring fresh heartbeats and healthy terrain", () => {
  const previous = assertEmptyLive(...sample());
  assertEmptyLive(...sample(2), previous);
  assert.throws(() => assertEmptyLive(...sample(), previous));
  for (const change of [
    ([p]) => p.snapshot.players.push({ id: "fake" }),
    ([p]) => (p.status = "starting"),
    ([, t]) => (t.status = "stale"),
    ([, t]) => (t.diagnostics.send_errors = 1),
    ([, t]) => (t.world_id = "another"),
    ([, t]) => (t.diagnostics.active_chunks = 1),
  ]) {
    const values = sample();
    change(values);
    assert.throws(() => assertEmptyLive(...values));
  }
});
test("log evidence classifies failures without retaining logs, passwords or tokens", () => {
  const raw = [
    "Version: 1.26.45.1",
    "Server started.",
    "[Scripting] [error]- ReferenceError: secret=DO-NOT-SAVE",
    "Surface tracker export unavailable (HTTP_401)",
    "Player connected: DO-NOT-SAVE",
  ];
  const report = inspectBdsLogs(raw);
  assert.equal(report.script_errors, 1);
  assert.equal(report.export_warnings, 1);
  assert.equal(report.player_connections, 1);
  assert.equal(report.expected_version_seen, true);
  assert.ok(!JSON.stringify(report).includes("DO-NOT-SAVE"));
});

const name = (s) => {
  const v = Buffer.from(s),
    n = Buffer.alloc(2);
  n.writeUInt16LE(v.length);
  return Buffer.concat([n, v]);
};
const byte = (s, v) =>
  Buffer.concat([Buffer.from([1]), name(s), Buffer.from([v])]);
function level(entries) {
  const body = Buffer.concat([
    Buffer.from([10]),
    name(""),
    ...entries,
    Buffer.from([0]),
  ]);
  const header = Buffer.alloc(8);
  header.writeUInt32LE(10);
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}
test("disposable experiment edit preserves unrelated NBT and enables Beta APIs idempotently", () => {
  const unrelated = byte("unrelated", 42);
  const experiments = Buffer.concat([
    Buffer.from([10]),
    name("experiments"),
    byte("another_experiment", 1),
    byte("gametest", 0),
    Buffer.from([0]),
  ]);
  const before = level([unrelated, experiments]);
  const after = enableDisposableBetaApis(before);
  assert.equal(before.readUInt32LE(4), before.length - 8);
  assert.equal(after.readUInt32LE(4), after.length - 8);
  for (const retained of [
    unrelated,
    byte("another_experiment", 1),
    byte("gametest", 1),
    byte("experiments_ever_used", 1),
    byte("saved_with_toggled_experiments", 1),
  ])
    assert.ok(after.includes(retained));
  assert.deepEqual(enableDisposableBetaApis(after), after);
  assert.ok(
    enableDisposableBetaApis(level([unrelated])).includes(byte("gametest", 1)),
  );
});
test("malformed NBT fails without a partial world edit", () => {
  const before = level([byte("keep", 1)]);
  assert.throws(() =>
    enableDisposableBetaApis(before.subarray(0, before.length - 1)),
  );
  const wrongRoot = Buffer.from(before);
  wrongRoot[8] = 1;
  assert.throws(() => enableDisposableBetaApis(wrongRoot));
  const duplicate = Buffer.concat([
    Buffer.from([10]),
    name("experiments"),
    Buffer.from([0]),
  ]);
  assert.throws(() => enableDisposableBetaApis(level([duplicate, duplicate])));
});
test("manual workflow pins every Action and cannot execute on pull requests", async () => {
  const yaml = await readFile(
    new URL(
      "../../.github/workflows/bds-panel-acceptance.yml",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(yaml, /workflow_dispatch:/);
  assert.match(yaml, /workflow_call:/);
  assert.match(yaml, /if: github.event_name == 'workflow_dispatch'/);
  assert.doesNotMatch(
    yaml,
    /^\s+(?:pull_request|pull_request_target|push|schedule):/m,
  );
  assert.doesNotMatch(
    yaml,
    /continue-on-error|secrets: inherit|permissions: write-all/,
  );
  for (const action of yaml.matchAll(/uses:\s+(\S+)/g))
    assert.match(action[1], /@[a-f0-9]{40}$/);
  assert.match(yaml, /persist-credentials: false/);
  assert.match(yaml, /ref: \$\{\{ inputs\.source_sha \}\}/);
  assert.match(yaml, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(yaml, /path: acceptance-harness/);
  assert.match(yaml, /working-directory: candidate/);
  assert.match(
    yaml,
    /node \.\.\/acceptance-harness\/scripts\/acceptance\/crafty-run\.mjs/,
  );
  assert.match(yaml, /contents: read/);
  assert.match(yaml, /actions: read/);
});
