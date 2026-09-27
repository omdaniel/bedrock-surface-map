import assert from "node:assert/strict";
import { test } from "node:test";
import { openGeneratedMap } from "./generated-browser.mjs";

function fixture({
  failures = 0,
  changed = false,
  mapExists = false,
  mapReady = mapExists,
  terrainInitialized = false,
  gotoError = false,
} = {}) {
  const messages = [],
    errors = [],
    timeout = Error("map readiness timeout");
  let navigations = 0,
    waits = 0;
  const page = {
    async goto(url, options) {
      assert.equal(url, "https://map.example.test/");
      assert.deepEqual(options, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      navigations++;
      if (gotoError && navigations <= failures)
        throw Error("net::ERR_NETWORK_CHANGED");
    },
    async waitForFunction(predicate, argument, options) {
      assert.equal(typeof predicate, "function");
      assert.equal(argument, undefined);
      assert.deepEqual(options, { timeout: 30_000 });
      waits++;
      if (navigations <= failures) {
        if (changed)
          messages.push("Failed to load resource: net::ERR_NETWORK_CHANGED");
        throw timeout;
      }
    },
    async evaluate(predicate) {
      const previous = globalThis.window;
      globalThis.window = {
        __map: mapExists
          ? {
              ready: mapReady,
              state: () => ({
                lod: terrainInitialized ? {} : null,
                cached: 0,
                draws: 0,
              }),
            }
          : undefined,
      };
      try {
        return predicate();
      } finally {
        if (previous === undefined) delete globalThis.window;
        else globalThis.window = previous;
      }
    },
  };
  return {
    page,
    messages,
    errors,
    timeout,
    counts: () => ({ navigations, waits }),
    run: () =>
      openGeneratedMap(page, "https://map.example.test/", messages, errors),
  };
}

test("healthy generated startup does not navigate twice", async () => {
  const f = fixture();
  await f.run();
  assert.deepEqual(f.counts(), { navigations: 1, waits: 1 });
});

test("one network change before application initialization retries startup", async () => {
  const f = fixture({ failures: 1, changed: true });
  await f.run();
  assert.deepEqual(f.counts(), { navigations: 2, waits: 2 });
});

test("navigation-level network change also has a single retry", async () => {
  const f = fixture({ failures: 1, gotoError: true });
  await f.run();
  assert.deepEqual(f.counts(), { navigations: 2, waits: 1 });
});

test("a debug handle without initialized terrain does not suppress the startup network retry", async () => {
  const f = fixture({
    failures: 1,
    changed: true,
    mapExists: true,
    mapReady: false,
  });
  await f.run();
  assert.deepEqual(f.counts(), { navigations: 2, waits: 2 });
});

test("repeated network changes fail after the bounded second attempt", async () => {
  const f = fixture({ failures: 2, changed: true });
  await assert.rejects(f.run(), (error) => error === f.timeout);
  assert.deepEqual(f.counts(), { navigations: 2, waits: 2 });
});

test("readiness and initialized-application failures are not retried", async () => {
  for (const options of [
    {},
    { changed: true, mapExists: true },
    {
      changed: true,
      mapExists: true,
      mapReady: false,
      terrainInitialized: true,
    },
  ]) {
    const f = fixture({ failures: 1, ...options });
    await assert.rejects(f.run(), (error) => error === f.timeout);
    assert.equal(f.counts().navigations, 1);
  }
});

test("JavaScript failures and earlier network warnings cannot trigger a retry", async () => {
  for (const jsError of [false, true]) {
    const f = fixture({ failures: 1, changed: jsError });
    if (jsError) f.errors.push("application error");
    else f.messages.push("net::ERR_NETWORK_CHANGED");
    await assert.rejects(f.run(), (error) => error === f.timeout);
    assert.equal(f.counts().navigations, 1);
  }
});
