import assert from "node:assert/strict";
import { test } from "node:test";
import { recoverableStartup, startGeneratedMap } from "./generated-startup.mjs";

const environment = {
  GITHUB_ACTIONS: "true",
  RUNNER_ENVIRONMENT: "github-hosted",
};
const message =
  "WebAssembly compilation aborted: Network error: Response body loading was aborted";
const state = { ready: false, draws: 0, message };

test("startup recovery excludes application faults, active rendering and ordinary hosts", () => {
  assert.equal(
    recoverableStartup(
      Error("navigation"),
      { ready: false, draws: 0, networkChanged: true },
      [],
      environment,
    ),
    true,
  );
  assert.equal(
    recoverableStartup(Error("timeout"), state, [message], environment),
    true,
  );
  for (const [candidate, errors, env] of [
    [{ ...state, ready: true }, [message], environment],
    [{ ...state, draws: 1 }, [message], environment],
    [state, ["CompileError: invalid WebAssembly"], environment],
    [{ ...state, message: "GPU device lost" }, [], environment],
    [state, [message], {}],
  ])
    assert.equal(
      recoverableStartup(Error("timeout"), candidate, errors, env),
      false,
    );
});

test("navigation during diagnostics preserves the original error and retries only a recorded network change", async () => {
  const prior = {
    GITHUB_ACTIONS: process.env.GITHUB_ACTIONS,
    RUNNER_ENVIRONMENT: process.env.RUNNER_ENVIRONMENT,
  };
  Object.assign(process.env, environment);
  try {
    let visits = 0;
    const page = {
      async goto() {
        if (++visits === 1) throw Error("net::ERR_NETWORK_CHANGED");
      },
      async waitForFunction() {},
      async waitForLoadState() {},
      async evaluate() {
        throw Error("Execution context was destroyed");
      },
    };
    const failures = ["net::ERR_NETWORK_CHANGED"];
    assert.equal(
      await startGeneratedMap(
        page,
        "https://map.example.test",
        [],
        [],
        failures,
      ),
      1,
    );
    assert.equal(visits, 2);
    assert.deepEqual(failures, []);
    page.goto = async () => {
      throw Error("unrelated application failure");
    };
    await assert.rejects(
      startGeneratedMap(page, "https://map.example.test", [], [], []),
      /unrelated application failure/,
    );
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("a repeated classified startup failure still fails after one recovery", async () => {
  const prior = {
    GITHUB_ACTIONS: process.env.GITHUB_ACTIONS,
    RUNNER_ENVIRONMENT: process.env.RUNNER_ENVIRONMENT,
  };
  Object.assign(process.env, environment);
  let visits = 0;
  const page = {
    async goto() {
      visits++;
    },
    async waitForFunction() {
      throw Error("timeout");
    },
    async evaluate() {
      return state;
    },
  };
  try {
    await assert.rejects(
      startGeneratedMap(page, "https://map.example.test", [message], []),
      /timeout/,
    );
    assert.equal(visits, 2);
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
