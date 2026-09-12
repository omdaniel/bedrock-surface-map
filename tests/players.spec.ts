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
