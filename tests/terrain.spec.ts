import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const directory = resolve(".local/terrain-fixture");
const roots = [0, 1, 2, 3].map((i) =>
  JSON.parse(readFileSync(resolve(directory, `root-${i}.json`), "utf8")),
);
test("live terrain and players retain selection, alignment and independent outage recovery", async ({
  page,
}) => {
  test.setTimeout(90000);
  let step = 0,
    x = -127.5,
    sequence = 0,
    terrainDown = false,
    playersDown = false;
  const template = JSON.parse(
    readFileSync("fixtures/tracking/snapshot.json", "utf8"),
  );
  await page.route("**/viewer-config.json", (r) =>
    r.fulfill({
      json: {
        terrain: {
          world_id: "fixture-world",
          generation: "fixture-generation",
          url: "/api/v1/worlds/fixture-world/terrain/manifest.json",
        },
        players: {
          world_id: "fixture-world",
          generation: "fixture-generation",
          source_sha256: roots[0].source_sha256,
          url: "/api/v1/worlds/fixture-world/players",
        },
      },
    }),
  );
  await page.route("**/api/v1/worlds/fixture-world/players", (r) => {
    const snapshot = structuredClone(template);
    snapshot.sequence = ++sequence;
    snapshot.sampled_at_ms = Date.now();
    snapshot.players[0].position = { x, y: 65, z: -127.5, heading: 90 };
    return r.fulfill({
      json: {
        schema_version: 1,
        world_id: "fixture-world",
        status: playersDown ? "unavailable" : "live",
        reason: null,
        age_ms: playersDown ? 31000 : 0,
        snapshot: playersDown ? null : snapshot,
      },
    });
  });
  let failedFirstRegion = false;
  await page.route("**/api/v1/worlds/fixture-world/terrain/**", (r) => {
    const path = new URL(r.request().url()).pathname;
    if (terrainDown) return r.fulfill({ status: 503 });
    if (path.endsWith("manifest.json"))
      return r.fulfill({ json: roots[step], headers: { ETag: `"${step}"` } });
    if (path.endsWith("status"))
      return r.fulfill({
        json: {
          world_id: "fixture-world",
          generation: "fixture-generation",
          status: "live",
          diagnostics: {},
        },
      });
    const name = path.split("/").at(-1)!;
    if (!failedFirstRegion && path.endsWith(roots[0].regions[0].surface.url)) {
      failedFirstRegion = true;
      return r.fulfill({ status: 404 });
    }
    return r.fulfill({
      body: readFileSync(resolve(directory, "state/objects", name)),
      contentType: name.endsWith(".png")
        ? "image/png"
        : name.endsWith(".json")
          ? "application/json"
          : "application/octet-stream",
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Players", exact: true }).click();
  await expect(page.locator(".players-status")).toHaveText("1 online");
  await page
    .getByRole("button", { name: "Center on ExamplePlayer", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.__map.state().cached), {
      timeout: 20000,
    })
    .toBe(1);
  await expect
    .poll(() => page.evaluate(() => window.__map.state().failures.length))
    .toBe(0);
  step = 1;
  await expect
    .poll(() => page.evaluate(() => window.__map.state().terrain?.revision), {
      timeout: 15000,
    })
    .toBe(2);
  expect(await page.evaluate(() => window.__map.state().cx)).toBe(x);
  await page.waitForTimeout(500);
  const draws = await page.evaluate(() => window.__map.state().draws);
  x = -125.5;
  await expect(page.locator(".player-detail")).toContainText("-126,");
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => window.__map.state().draws)).toBe(draws);
  const alignment = await page.evaluate(() => {
    const s = window.__map.state(),
      marker = document.querySelector<HTMLElement>(".player-marker")!,
      box = document.querySelector("canvas")!.getBoundingClientRect();
    const transform = new DOMMatrixReadOnly(marker.style.transform);
    return {
      actual: transform.m41,
      expected: box.width / 2 + (-125.5 - s.cx) * s.scale,
    };
  });
  expect(alignment.actual).toBeCloseTo(alignment.expected, 1);
  await page
    .getByRole("button", { name: "Follow ExamplePlayer", exact: true })
    .click();
  terrainDown = true;
  await expect(page.locator(".local-state")).toHaveText("Terrain delayed", {
    timeout: 15000,
  });
  x = -124.5;
  await expect.poll(() => page.evaluate(() => window.__map.state().cx)).toBe(x);
  await expect(page.locator(".players-status")).toHaveText("1 online");
  step = 2;
  terrainDown = false;
  await expect
    .poll(() => page.evaluate(() => window.__map.state().terrain?.revision), {
      timeout: 20000,
    })
    .toBe(3);
  await expect(page.locator(".player-follow")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  playersDown = true;
  step = 3;
  await expect(page.locator(".player-row")).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => window.__map.state().terrain?.revision), {
      timeout: 15000,
    })
    .toBe(4);
  playersDown = false;
  await expect(page.locator(".player-row")).toHaveCount(1);
  await expect(page.locator(".local-state")).toHaveText("Terrain live");
  await page.screenshot({ path: "test-results/combined-terrain-players.png" });
});
test("live chunks update picking and shadows without resetting the camera", async ({
  page,
}) => {
  let step = 0;
  const requests: string[] = [];
  await page.route("**/viewer-config.json", (r) =>
    r.fulfill({
      json: {
        players: null,
        terrain: {
          world_id: "fixture-world",
          generation: "fixture-generation",
          url: "/api/v1/worlds/fixture-world/terrain/manifest.json",
        },
      },
    }),
  );
  await page.route("**/api/v1/worlds/fixture-world/terrain/**", (r) => {
    const path = new URL(r.request().url()).pathname;
    requests.push(path);
    if (path.endsWith("/manifest.json"))
      return r.fulfill({
        json: roots[step],
        headers: { ETag: `\"step-${step}\"` },
      });
    if (path.endsWith("/status"))
      return r.fulfill({
        json: {
          world_id: "fixture-world",
          generation: "fixture-generation",
          status: "live",
          last_repair_ms: 1000,
          diagnostics: { queued: 0 },
        },
      });
    const name = path.split("/").at(-1)!;
    return r.fulfill({
      body: readFileSync(resolve(directory, "state/objects", name)),
      contentType: name.endsWith(".png")
        ? "image/png"
        : name.endsWith(".json")
          ? "application/json"
          : "application/octet-stream",
    });
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect.poll(() => page.evaluate(() => window.__map?.ready)).toBe(true);
  await expect
    .poll(() => page.evaluate(() => window.__map.state().cached))
    .toBe(1);
  await page.evaluate(() => window.__map.spawn());
  await page.waitForTimeout(2500);
  const before = await page.evaluate(() => window.__map.state());
  const count = requests.length;
  step = 1;
  await expect
    .poll(() => page.evaluate(() => window.__map.state().terrain?.revision), {
      timeout: 15000,
    })
    .toBe(2);
  const after = await page.evaluate(() => window.__map.state());
  expect([after.cx, after.cz, after.scale]).toEqual([
    before.cx,
    before.cz,
    before.scale,
  ]);
  expect(after.terrain?.changedChunks).toBeGreaterThan(0);
  const canvas = page.locator("canvas#map"),
    box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2 + 2, box.y + box.height / 2 + 2);
  await expect(page.locator("#block-name")).toHaveText("sand");
  await expect(page.locator("#block-pos")).toContainText("16");
  expect(
    requests
      .slice(count)
      .some((p) =>
        p.endsWith(roots[1].regions[0].surface.url.split("/").at(-1)),
      ),
  ).toBe(false);
  const stable = await page.evaluate(() => window.__map.state().draws);
  await page.waitForTimeout(4500);
  expect(await page.evaluate(() => window.__map.state().draws)).toBe(stable);
  step = 2;
  await expect
    .poll(() => page.evaluate(() => window.__map.state().terrain?.revision), {
      timeout: 15000,
    })
    .toBe(3);
  await page.evaluate(() => window.__map.pan(1160, 140));
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const s = window.__map.state(),
            w = s.terrain?.window;
          return (
            !!w &&
            w[0] <= s.cx &&
            w[1] <= s.cz &&
            w[2] > s.cx &&
            w[3] > s.cz &&
            !s.terrain?.busy &&
            s.pending === 0
          );
        }),
      {
        timeout: 15000,
      },
    )
    .toBe(true);
  await page.mouse.move(box.x + box.width / 2 + 1, box.y + box.height / 2 + 1);
  await expect(page.locator("#block-pos")).toContainText("5");
  step = 3;
  await expect
    .poll(() => page.evaluate(() => window.__map.state().terrain?.revision), {
      timeout: 15000,
    })
    .toBe(4);
  await page.evaluate(() => window.__map.pan(3072, 4092));
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const s = window.__map.state(),
            w = s.terrain?.window;
          return (
            !!w &&
            w[0] <= s.cx &&
            w[1] <= s.cz &&
            w[2] > s.cx &&
            w[3] > s.cz &&
            !s.terrain?.busy &&
            s.pending === 0
          );
        }),
      { timeout: 15000 },
    )
    .toBe(true);
  await page.mouse.move(box.x + box.width / 2 + 2, box.y + box.height / 2 + 2);
  await expect(page.locator("#block-pos")).toContainText("10");
  await page.screenshot({ path: "test-results/terrain-growth.png" });
  expect(
    (await page.evaluate(() => window.__map.state())).memory,
  ).toBeLessThanOrEqual(256 * 1024 * 1024);
  expect(errors).toEqual([]);
});
