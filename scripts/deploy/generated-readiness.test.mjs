import assert from "node:assert/strict";
import test from "node:test";
import { waitForJson } from "./generated-readiness.mjs";

const starting = { status: "starting" };
const ready = () => ({
  status: 200,
  body: Buffer.from(JSON.stringify(starting)),
});
const options = { label: "players", timeoutMs: 1000, intervalMs: 0 };

test("restart gateway errors are checked before parsing; recovery returns JSON", async () => {
  const statuses = [502, 503, 504, 200];
  let calls = 0;
  const result = await waitForJson(async () => {
    const status = statuses[calls++];
    if (status === 200) return ready();
    return {
      status,
      get body() {
        assert.fail("a gateway error body must not be parsed");
      },
    };
  }, options);
  assert.deepEqual(result, starting);
  assert.equal(calls, 4);
});

test("empty or malformed HTTP 200 JSON fails immediately, even if the next response is valid", async () => {
  for (const body of ["", "{", "not JSON"]) {
    let calls = 0;
    await assert.rejects(
      waitForJson(async () => {
        calls++;
        return calls === 1 ? { status: 200, body: Buffer.from(body) } : ready();
      }, options),
      SyntaxError,
    );
    assert.equal(calls, 1);
  }
});

test("unexpected HTTP statuses fail immediately without parsing", async () => {
  for (const status of [204, 301, 401, 403, 404, 500]) {
    let calls = 0;
    await assert.rejects(
      waitForJson(async () => {
        calls++;
        return { status, body: Buffer.alloc(0) };
      }, options),
      new RegExp(`players: expected HTTP 200, received HTTP ${status}`),
    );
    assert.equal(calls, 1);
  }
});

test("temporary connection failures during restart can recover", async () => {
  const codes = ["ECONNREFUSED", "ECONNRESET", "EPIPE", "ETIMEDOUT"];
  let calls = 0;
  assert.deepEqual(
    await waitForJson(async () => {
      const code = codes[calls++];
      if (code) throw Object.assign(Error("connection unavailable"), { code });
      return ready();
    }, options),
    starting,
  );
  assert.equal(calls, 5);
});

test("TLS and other unexpected request failures are not retried", async () => {
  for (const code of [
    "CERT_HAS_EXPIRED",
    "ERR_TLS_CERT_ALTNAME_INVALID",
    undefined,
  ]) {
    let calls = 0;
    const failure = Object.assign(Error("not a restart failure"), { code });
    await assert.rejects(
      waitForJson(async () => {
        calls++;
        throw failure;
      }, options),
      (error) => error === failure,
    );
    assert.equal(calls, 1);
  }
});

test(
  "permanent empty 502 fails at the deadline with HTTP evidence, not a JSON error",
  { timeout: 1000 },
  async () => {
    let calls = 0;
    await assert.rejects(
      waitForJson(
        async () => {
          calls++;
          return { status: 502, body: Buffer.alloc(0) };
        },
        { ...options, timeoutMs: 25, intervalMs: 2 },
      ),
      /players: not ready within 25 ms \(\d+ attempts; last failure: HTTP 502\)/,
    );
    assert.ok(calls >= 1);
  },
);

test(
  "the same deadline aborts an in-flight request",
  { timeout: 1000 },
  async () => {
    let aborted = false;
    await assert.rejects(
      waitForJson(
        (signal) =>
          new Promise((resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                aborted = true;
                reject(signal.reason);
              },
              { once: true },
            );
          }),
        { ...options, timeoutMs: 25 },
      ),
      /players: not ready within 25 ms \(1 attempts; last failure: no response\)/,
    );
    assert.equal(aborted, true);
  },
);

test("valid JSON does not bypass the caller's exact starting-state assertion", async () => {
  let calls = 0;
  await assert.rejects(async () => {
    const result = await waitForJson(async () => {
      calls++;
      return { status: 200, body: '{"status":"live"}' };
    }, options);
    assert.equal(result.status, "starting");
  }, assert.AssertionError);
  assert.equal(calls, 1);
});
