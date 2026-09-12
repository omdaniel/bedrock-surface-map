import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const directory = resolve(".local/terrain-fixture");
const roots = [0, 1, 2, 3].map((i) =>
  JSON.parse(readFileSync(resolve(directory, `root-${i}.json`), "utf8")),
);
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
    .poll(() => page.evaluate(() => window.__map.state().cached), {
      timeout: 15000,
    })
    .toBeGreaterThan(0);
  expect(
    (await page.evaluate(() => window.__map.state())).memory,
  ).toBeLessThanOrEqual(256 * 1024 * 1024);
  expect(errors).toEqual([]);
});
