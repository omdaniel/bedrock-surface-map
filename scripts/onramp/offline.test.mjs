import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { platformFor } from "./tools.mjs";
import { probe } from "./process.mjs";

test("unsupported developer platforms are rejected before setup work", () => {
  assert.equal(platformFor("darwin", "arm64"), "darwin-arm64");
  assert.equal(platformFor("linux", "x64"), "linux-x86_64");
  assert.throws(
    () => platformFor("win32", "x64"),
    /Unsupported developer-tool platform/,
  );
});

test("Git preference probes use the selected checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "bedrock-hooks-checkout-"));
  try {
    assert.equal(spawnSync("git", ["init", root]).status, 0);
    assert.equal(
      spawnSync("git", ["-C", root, "config", "core.hooksPath", "custom-hooks"])
        .status,
      0,
    );
    assert.equal(
      probe("git", ["config", "--local", "--get", "core.hooksPath"], {
        cwd: root,
      }),
      "custom-hooks",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline setup rejects a missing Rust toolchain without contacting rustup", async () => {
  const home = await mkdtemp(join(tmpdir(), "bedrock-rustup-empty-"));
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(503).end();
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const child = spawn(
      process.execPath,
      [resolve("scripts/dev.mjs"), "setup", "--offline"],
      {
        env: {
          ...process.env,
          RUSTUP_HOME: home,
          RUSTUP_DIST_SERVER: url,
          RUSTUP_UPDATE_ROOT: url,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (chunk) => (output += chunk));
    const code = await new Promise((done, reject) => {
      child.once("error", reject);
      child.once("exit", done);
    });
    assert.equal(code, 2, output);
    assert.match(output, /Offline setup is missing Rust toolchain/);
    assert.equal(requests, 0);
  } finally {
    await new Promise((done) => server.close(done));
    await rm(home, { recursive: true, force: true });
  }
});

test("doctor reports a missing toolchain without installing it or making network requests", async () => {
  const home = await mkdtemp(join(tmpdir(), "bedrock-doctor-empty-"));
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(503).end();
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const child = spawn(
      process.execPath,
      [resolve("scripts/dev.mjs"), "doctor", "--json"],
      {
        cwd: tmpdir(),
        env: {
          ...process.env,
          RUSTUP_HOME: home,
          RUSTUP_DIST_SERVER: url,
          RUSTUP_UPDATE_ROOT: url,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "",
      errors = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (errors += chunk));
    const code = await new Promise((done, reject) => {
      child.once("error", reject);
      child.once("exit", done);
    });
    assert.equal(code, 1, errors);
    const report = JSON.parse(output);
    assert.equal(report.ok, false);
    assert.equal(
      report.checks.find((check) => check.name === "Rust").ok,
      false,
    );
    assert.match(
      report.checks.find((check) => check.name === "Rust").fix,
      /setup/,
    );
    assert.equal(requests, 0);
  } finally {
    await new Promise((done) => server.close(done));
    await rm(home, { recursive: true, force: true });
  }
});
