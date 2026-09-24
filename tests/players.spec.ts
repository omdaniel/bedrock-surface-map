import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
const manifest = JSON.parse(
  readFileSync("web/public/maps/fixture/manifest.json", "utf8"),
);
const template = JSON.parse(
  readFileSync("fixtures/tracking/snapshot.json", "utf8"),
);

async function waitForTerrainIdle(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.waitForFunction(() => {
    const state = window.__map?.state();
    return (
      window.__map?.ready &&
      state.cached > 0 &&
      state.pending === 0 &&
      !state.renderPending &&
      !state.terrain?.busy &&
      state.firstVisible !== null
    );
  });
}
test("100ms eight-player polling is single-flight and leaves stationary terrain alone", async ({
  page,
}) => {
  let calls = 0,
    active = 0,
    peak = 0,
    delay = 0;
  await page.route("**/viewer-config.json", (r) =>
    r.fulfill({
      json: {
        players: {
          world_id: "fixture-world",
          source_sha256: manifest.source_sha256,
          url: "/api/v1/worlds/fixture-world/players",
          poll_interval_ms: 100,
        },
      },
    }),
  );
  await page.route("**/api/v1/worlds/fixture-world/players", async (r) => {
    calls++;
    active++;
    peak = Math.max(peak, active);
    const s = structuredClone(template);
    s.sequence = calls;
    s.sampled_at_ms = Date.now();
    s.players = Array.from({ length: 8 }, (_, i) => ({
      ...structuredClone(s.players[0]),
      id: `p${i}`,
      name: `FixturePlayer${i}`,
      discontinuity: calls === 1,
      position: { x: -12 + i + calls / 20, y: 64, z: i, heading: 90 },
    }));
    try {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      await r.fulfill({
        json: {
          schema_version: 1,
          world_id: "fixture-world",
          status: "live",
          reason: null,
          age_ms: 0,
          snapshot: s,
        },
      });
    } finally {
      active--;
    }
  });
  await page.goto("/?map=/maps/fixture/manifest.json&terrain=off");
  await expect(page.locator(".player-marker")).toHaveCount(8);
  await waitForTerrainIdle(page);
  const draws = await page.evaluate(
    () => (window.__map.state() as { draws: number }).draws,
  );
  const before = calls;
  await page.waitForTimeout(2000);
  expect(calls - before).toBeGreaterThanOrEqual(12);
  expect(calls - before).toBeLessThanOrEqual(23);
  expect(
    await page.evaluate(
      () => (window.__map.state() as { draws: number }).draws,
    ),
  ).toBe(draws);
  delay = 180;
  await page.waitForTimeout(1000);
  expect(peak).toBe(1);
  await page.unrouteAll({ behavior: "wait" });
});
test("operator-selected offline manifest loads without a deployment-specific default", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (r) => requests.push(new URL(r.url()).pathname));
  await page.route("**/viewer-config.json", (r) =>
    r.fulfill({
      json: {
        players: null,
        map: "maps/fixture/manifest.json",
      },
    }),
  );
  await page.goto("/?terrain=off");
  await page.waitForFunction(
    () => window.__map?.ready && window.__map.state().cached > 0,
  );
  expect(
    requests.filter(
      (url) => url.includes("/maps/") && url.endsWith("manifest.json"),
    ),
  ).toEqual(["/maps/fixture/manifest.json"]);
  expect(await page.locator(".identity strong").textContent()).toBe(
    manifest.name,
  );
});
test("player roster, center/follow, overlay-only updates, expiry and mobile", async ({
  page,
}) => {
  let x = -12.25,
    seq = 1,
    unavailable = false;
  await page.route("**/viewer-config.json", (r) =>
    r.fulfill({
      json: {
        players: {
          world_id: "fixture-world",
          source_sha256: manifest.source_sha256,
          url: "/api/v1/worlds/fixture-world/players",
        },
      },
    }),
  );
  await page.route("**/api/v1/worlds/fixture-world/players", (r) => {
    const s = structuredClone(template);
    s.sequence = seq++;
    s.sampled_at_ms = Date.now();
    s.players[0].position.x = x;
    s.players[0].name = "Example <img onerror=alert(1)>";
    s.players.push({
      ...structuredClone(s.players[0]),
      id: "p2",
      name: "OtherPlayer",
      dimension: "minecraft:nether",
    });
    return r.fulfill({
      json: {
        schema_version: 1,
        world_id: "fixture-world",
        status: unavailable ? "unavailable" : "live",
        reason: null,
        age_ms: unavailable ? 31000 : 0,
        snapshot: unavailable ? null : s,
      },
    });
  });
  await page.goto("/?map=/maps/fixture/manifest.json");
  await page.waitForFunction(() => window.__map?.ready);
  await page.getByRole("button", { name: "Players", exact: true }).click();
  await expect(page.locator(".players-status")).toHaveText("2 online");
  await expect(page.locator(".player-row")).toHaveCount(2);
  await expect(page.locator(".player-row img")).toHaveCount(0);
  await page
    .getByRole("button", {
      name: "Center on Example <img onerror=alert(1)>",
      exact: true,
    })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => (window.__map.state() as { cx: number }).cx),
    )
    .toBe(x);
  expect(
    (await page.evaluate(() => window.__map.state())) as { scale: number },
  ).toHaveProperty("scale", 3);
  await expect(
    page.getByRole("button", { name: "Center on OtherPlayer", exact: true }),
  ).toBeDisabled();
  await waitForTerrainIdle(page);
  const draws = await page.evaluate(
    () => (window.__map.state() as { draws: number }).draws,
  );
  x = -9;
  await expect(page.locator(".player-detail").first()).toContainText("-9,");
  await page.waitForTimeout(400);
  expect(
    await page.evaluate(
      () => (window.__map.state() as { draws: number }).draws,
    ),
  ).toBe(draws);
  await page
    .getByRole("button", {
      name: "Follow Example <img onerror=alert(1)>",
      exact: true,
    })
    .click();
  x = -5;
  await expect
    .poll(() =>
      page.evaluate(() => (window.__map.state() as { cx: number }).cx),
    )
    .toBe(-5);
  await page.locator("canvas").focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator(".player-follow").first()).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: "test-results/players-mobile.png" });
  unavailable = true;
  await expect(page.locator(".players-status")).toHaveText(
    "Player positions unavailable",
  );
  await expect(page.locator(".player-row")).toHaveCount(0);
  await expect(page.locator(".player-marker")).toHaveCount(0);
});
test("unbound snapshot has an honest player status and no requests", async ({
  page,
}) => {
  let requests = 0;
  page.on("request", (r) => {
    if (r.url().includes("/api/v1/worlds/")) requests++;
  });
  await page.goto("/?map=/maps/fixture/manifest.json");
  await page.waitForFunction(() => window.__map?.ready);
  await page.getByRole("button", { name: "Players", exact: true }).click();
  await expect(page.locator(".players-status")).toContainText("No live feed");
  expect(requests).toBe(0);
});
test("unloaded terrain is distinct from a player outside the snapshot", async ({
  page,
}) => {
  let sequence = 1;
  await page.route("**/viewer-config.json", (route) =>
    route.fulfill({
      json: {
        players: {
          world_id: "fixture-world",
          source_sha256: manifest.source_sha256,
          url: "/api/v1/worlds/fixture-world/players",
        },
      },
    }),
  );
  await page.route("**/*.bsm.zst", (route) =>
    route.fulfill({ status: 503, body: "unavailable" }),
  );
  await page.route("**/api/v1/worlds/fixture-world/players", (route) => {
    const snapshot = structuredClone(template);
    snapshot.sequence = sequence++;
    snapshot.sampled_at_ms = Date.now();
    snapshot.players[0].position.x = -12;
    snapshot.players[0].position.z = -12;
    snapshot.players.push({
      ...structuredClone(snapshot.players[0]),
      id: "outside",
      name: "OutsidePlayer",
      position: { x: 1024, z: 1024, y: 64, heading: 0 },
    });
    return route.fulfill({
      json: {
        schema_version: 1,
        world_id: "fixture-world",
        status: "live",
        age_ms: 0,
        reason: null,
        snapshot,
      },
    });
  });
  await page.goto("/?map=/maps/fixture/manifest.json");
  await page.getByRole("button", { name: "Players", exact: true }).click();
  await expect(page.locator(".player-detail").first()).toContainText(
    "terrain not loaded",
  );
  await expect(page.locator(".player-detail").nth(1)).toContainText(
    "outside mapped terrain",
  );
  for (const width of [1100, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const message = await page.locator("#message").boundingBox();
    const roster = await page.locator("#players-panel").boundingBox();
    expect(message!.y + message!.height).toBeLessThanOrEqual(roster!.y);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await page.screenshot({ path: "test-results/players-retry-mobile.png" });
  await page.unroute("**/*.bsm.zst");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.locator(".player-detail").first()).not.toContainText(
    "terrain not loaded",
  );
  await expect(page.locator(".player-detail").first()).not.toContainText(
    "outside mapped terrain",
  );
});

test("per-view disable never loads tracking configuration or positions", async ({
  page,
}) => {
  let requests = 0;
  page.on("request", (r) => {
    if (
      r.url().includes("viewer-config.json") ||
      r.url().includes("/api/v1/worlds/")
    )
      requests++;
  });
  await page.goto("/?map=/maps/fixture/manifest.json&players=off");
  await page.waitForFunction(() => window.__map?.ready);
  await page.getByRole("button", { name: "Players", exact: true }).click();
  await expect(page.locator(".players-status")).toHaveText(
    "Tracking disabled in this view",
  );
  expect(requests).toBe(0);
});

test("high-DPR projection, overlapping labels, teleports and dimensions", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 1100, height: 760 },
    deviceScaleFactor: 2,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  let x = -12.25,
    dimension = "minecraft:overworld",
    seq = 1;
  await page.route("**/viewer-config.json", (r) =>
    r.fulfill({
      json: {
        players: {
          world_id: "fixture-world",
          source_sha256: manifest.source_sha256,
          url: "/api/v1/worlds/fixture-world/players",
        },
      },
    }),
  );
  await page.route("**/api/v1/worlds/fixture-world/players", (r) => {
    const s = structuredClone(template);
    s.sequence = seq++;
    s.sampled_at_ms = Date.now();
    s.players[0].position.x = x;
    s.players[0].dimension = dimension;
    s.players.push({
      ...structuredClone(s.players[0]),
      id: "neighbor",
      name: "Neighbor",
    });
    return r.fulfill({
      json: {
        schema_version: 1,
        world_id: "fixture-world",
        status: "live",
        reason: null,
        age_ms: 0,
        snapshot: s,
      },
    });
  });
  try {
    await page.goto("/?map=/maps/fixture/manifest.json");
    await page.waitForFunction(() => window.__map?.ready);
    await page.getByRole("button", { name: "Players", exact: true }).click();
    await page
      .getByRole("button", { name: "Center on ExamplePlayer", exact: true })
      .click();
    const alignment = () =>
      page.evaluate(() => {
        const marker = document.querySelector<HTMLElement>(".player-marker")!;
        const transform = new DOMMatrixReadOnly(marker.style.transform);
        const canvas = document
          .querySelector("canvas")!
          .getBoundingClientRect();
        return {
          dx: transform.m41 - canvas.width / 2,
          dy: transform.m42 - canvas.height / 2,
        };
      });
    await expect.poll(alignment).toEqual({ dx: 0, dy: 0 });
    await expect(page.locator(".player-label:not([hidden])")).toHaveCount(1);
    await page.setViewportSize({ width: 800, height: 600 });
    await expect
      .poll(async () => Math.abs((await alignment()).dx))
      .toBeLessThan(0.1);
    await page
      .getByRole("button", { name: "Follow ExamplePlayer", exact: true })
      .click();
    x = -10000;
    await expect
      .poll(() =>
        page.evaluate(() => (window.__map.state() as { cx: number }).cx),
      )
      .toBe(x);
    await expect(page.locator(".player-detail").first()).toContainText(
      "outside mapped terrain",
    );
    dimension = "minecraft:nether";
    await expect(page.locator(".player-marker:not([hidden])")).toHaveCount(0);
    await expect(page.locator(".player-row")).toHaveCount(2);
    await expect(page.locator(".player-follow").first()).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  } finally {
    await context.close();
  }
});

test("stationary samples age despite successful HTTP; hidden tab resumes immediately", async ({
  page,
}) => {
  test.setTimeout(60000);
  let calls = 0;
  const s = structuredClone(template);
  s.sampled_at_ms = Date.now();
  await page.route("**/viewer-config.json", (r) =>
    r.fulfill({
      json: {
        players: {
          world_id: "fixture-world",
          source_sha256: manifest.source_sha256,
          url: "/api/v1/worlds/fixture-world/players",
        },
      },
    }),
  );
  await page.route("**/api/v1/worlds/fixture-world/players", (r) => {
    calls++;
    return r.fulfill({
      json: {
        schema_version: 1,
        world_id: "fixture-world",
        status: "live",
        reason: null,
        age_ms: 0,
        snapshot: s,
      },
    });
  });
  await page.goto("/?map=/maps/fixture/manifest.json");
  await page.waitForFunction(() => window.__map?.ready);
  await page.getByRole("button", { name: "Players", exact: true }).click();
  await expect(page.locator(".player-row")).toHaveCount(1);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const hiddenCalls = calls;
  await page.waitForTimeout(2500);
  expect(calls).toBe(hiddenCalls);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect
    .poll(() => calls, { timeout: 1000 })
    .toBeGreaterThan(hiddenCalls);
  await expect(page.locator(".players-status")).toContainText(
    "Stale positions",
    { timeout: 12000 },
  );
  await expect(page.locator(".player-row")).toHaveCount(0, { timeout: 23000 });
  await expect(page.locator(".player-marker")).toHaveCount(0);
});
