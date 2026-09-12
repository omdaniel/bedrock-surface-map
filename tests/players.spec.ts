import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
const manifest = JSON.parse(
  readFileSync("web/public/maps/fixture/manifest.json", "utf8"),
);
const template = JSON.parse(
  readFileSync("fixtures/tracking/snapshot.json", "utf8"),
);
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
  await page.waitForFunction(
    () => (window.__map.state() as { pending: number }).pending === 0,
  );
  await page.waitForTimeout(400);
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
