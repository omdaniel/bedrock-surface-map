import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

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
