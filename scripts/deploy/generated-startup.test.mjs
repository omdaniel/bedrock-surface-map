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
