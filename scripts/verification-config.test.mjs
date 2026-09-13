import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  verificationConfig,
  viewerUrl,
  isPlayerResponse,
  waitForMap,
} from "./verification-config.mjs";

test("verification uses loopback defaults and explicit operator configuration", () => {
  const dir = mkdtempSync(join(tmpdir(), "surface-config-"));
  try {
    const file = join(dir, "config.json");
    writeFileSync(
      file,
      JSON.stringify({
        url: "https://map.example.test:9443/demo/",
        output: dir,
        "expected-regions": 7,
        browser: "safari",
        webdriver: "http://localhost:5555",
      }),
    );
    const options = { browser: { type: "string", default: "chrome" } };
    const saved = verificationConfig({
      argv: [],
      env: { MAP_VERIFY_CONFIG: file },
      options,
    });
    assert.equal(saved.url, "https://map.example.test:9443/demo/");
    assert.equal(saved.browser, "safari");
    assert.equal(saved.expectedRegions, 7);
    assert.equal(saved.webdriver, "http://localhost:5555");
    const override = verificationConfig({
      argv: [
        "--config",
        file,
        "--url",
        "https://10.23.45.67:9444/",
        "--browser",
        "chrome",
      ],
      env: { MAP_URL: "https://map.example.test/" },
      options,
    });
    assert.equal(override.url, "https://10.23.45.67:9444/");
    assert.equal(override.browser, "chrome");
    const empty = verificationConfig({ argv: [], env: {} });
    assert.equal(new URL(empty.url).hostname, "127.0.0.1");
    assert.equal(empty.expectedRegions, null);
    assert.throws(() =>
      verificationConfig({ argv: ["--expected-regions", "0"], env: {} }),
    );
    assert.throws(() =>
      verificationConfig({
        argv: ["--webdriver", "http://10.1.2.3:4444"],
        env: {},
      }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("viewer URLs require a secure context and never accept credentials", () => {
  for (const url of [
    "https://map.example.test/base/?map=/maps/fixture/manifest.json",
    "https://172.20.30.40:9443/",
    "http://localhost:5012/",
    "http://[::1]:5012/",
  ])
    assert.doesNotThrow(() => viewerUrl(url));
  for (const url of [
    "http://10.1.2.3/",
    "file:///private/world",
    "https://user:secret@map.example.test/",
    "javascript:alert(1)",
  ])
    assert.throws(() => viewerUrl(url));
});

test("player response matching is world-independent and origin-bound", () => {
  const viewer = "https://map.example.test:9443/subpath/";
  assert.equal(
    isPlayerResponse(
      "https://map.example.test:9443/subpath/api/v1/worlds/another-world/players",
      viewer,
    ),
    true,
  );
  for (const path of [
    "https://elsewhere.example.test/api/v1/worlds/another-world/players",
    "https://map.example.test:9443/api/v1/worlds/another-world/players?redirect=1",
    "https://map.example.test:9443/api/v1/worlds/another-world/terrain/status",
  ])
    assert.equal(isPlayerResponse(path, viewer), false);
});

test("map readiness does not require a particular world size", async () => {
  let condition, expected;
  await waitForMap(
    {
      waitForFunction: async (fn, value) => {
        condition = fn;
        expected = value;
      },
    },
    { expectedRegions: null },
  );
  const prior = globalThis.window;
  try {
    for (const count of [1, 7, 128]) {
      globalThis.window = {
        __map: {
          ready: true,
          state: () => ({ cached: count, pending: 0, firstVisible: 10 }),
        },
      };
      assert.equal(condition(expected), true);
      assert.equal(condition(count + 1), false);
    }
  } finally {
    if (prior === undefined) delete globalThis.window;
    else globalThis.window = prior;
  }
});
