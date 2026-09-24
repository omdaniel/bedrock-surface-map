import { test, expect, type Page } from "@playwright/test";
import { PNG } from "pngjs";

async function ready(page: Page) {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const state = window.__map?.state();
          return Boolean(
            window.__map?.ready &&
            state?.lod &&
            state.lod.tiles > 0 &&
            state.lod.pending === 0 &&
            state.lod.firstVisible !== null &&
            !state.renderPending,
          );
        }),
      { timeout: 60000 },
    )
    .toBe(true);
}
async function nonblank(page: Page) {
  const png = PNG.sync.read(await page.locator("#map").screenshot());
  const colors = new Set<string>();
  for (let y = 0; y < png.height; y += 11)
    for (let x = 0; x < png.width; x += 11) {
      const i = (y * png.width + x) * 4;
      colors.add(
        `${png.data[i] >> 3},${png.data[i + 1] >> 3},${png.data[i + 2] >> 3}`,
      );
    }
  expect(colors.size).toBeGreaterThan(20);
}

test("encoded coarse coverage refines, releases exact detail, and preserves camera controls", async ({
  page,
}) => {
  test.setTimeout(180000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto("/?lod=/maps/lod-fixture/lod.json&players=off");
  await ready(page);
  await page.evaluate(() =>
    window.__map.zoom(0.12 / window.__map.state().scale),
  );
  await ready(page);
  const coarse = await page.evaluate(() => window.__map.state());
  expect(coarse.lod!.level).toBeGreaterThan(0);
  expect(coarse.memory).toBeLessThanOrEqual(200000000);
  await nonblank(page);
  await page.screenshot({ path: "test-results/lod-coarse.png" });

  await page.evaluate(() => window.__map.zoom(6 / window.__map.state().scale));
  await expect
    .poll(() => page.evaluate(() => window.__map.state().lod?.level), {
      timeout: 60000,
    })
    .toBe(0);
  await ready(page);
  const fine = await page.evaluate(() => window.__map.state());
  expect(fine.scale).toBeCloseTo(6);
  expect(fine.memory).toBeLessThanOrEqual(200000000);
  await nonblank(page);
  const canvas = await page.locator("#map").boundingBox();
  await page.mouse.move(
    canvas!.x + canvas!.width / 2,
    canvas!.y + canvas!.height / 2,
  );
  await expect(page.locator("#inspect")).toBeVisible();
  await expect(page.locator("#block-name")).not.toHaveText("Surface summary");
  await page.screenshot({ path: "test-results/lod-fine.png" });

  await page
    .getByRole("button", { name: "Lighting and color", exact: true })
    .click();
  await page
    .getByRole("slider", { name: "Sun elevation", exact: true })
    .evaluate((element: HTMLInputElement) => {
      element.value = "15";
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  expect((await page.evaluate(() => window.__map.state())).elevation).toBe(15);
  await page.evaluate(() => window.__map.pan(-30, 25));
  const moved = await page.evaluate(() => window.__map.state());
  expect(moved.cx).toBeCloseTo(fine.cx - 30);
  expect(moved.cz).toBeCloseTo(fine.cz + 25);
  expect(moved.scale).toBeCloseTo(6);

  await page.evaluate(() =>
    window.__map.zoom(0.12 / window.__map.state().scale),
  );
  await ready(page);
  await expect
    .poll(() => page.evaluate(() => window.__map.state().lod!.tiles), {
      timeout: 15000,
    })
    .toBeLessThan(fine.lod!.tiles);
  const returned = await page.evaluate(() => window.__map.state());
  expect(returned.lod!.memory.peakBytes).toBeLessThanOrEqual(200000000);
  expect(returned.lod!.mainWasmBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
  expect(returned.lod!.workerWasmBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
  expect(returned.lod!.level).toBeGreaterThan(0);
  expect(returned.lod!.failures).toEqual([]);
  expect(errors).toEqual([]);
  await page.screenshot({ path: "test-results/lod-returned.png" });
});

test("LOD keeps responsive navigation when detail requests fail", async ({
  page,
}) => {
  test.setTimeout(120000);
  await page.goto("/?lod=/maps/lod-fixture/lod.json&players=off");
  await ready(page);
  await page.evaluate(() =>
    window.__map.zoom(0.12 / window.__map.state().scale),
  );
  await ready(page);
  await page.route("**/maps/lod-fixture/objects/**", (route) =>
    route.fulfill({ status: 503, body: "unavailable" }),
  );
  const before = await page.evaluate(() => window.__map.state());
  await page.evaluate(() => {
    window.__map.zoom(50);
    window.__map.pan(15, -10);
  });
  await expect
    .poll(() => page.evaluate(() => window.__map.state().draws))
    .toBeGreaterThan(before.draws);
  const after = await page.evaluate(() => window.__map.state());
  expect(after.cx).toBeCloseTo(before.cx + 15);
  expect(after.cz).toBeCloseTo(before.cz - 10);
  expect(after.scale).toBeCloseTo(before.scale * 50);
  expect(after.memory).toBeLessThanOrEqual(200000000);
  await nonblank(page);
});

test("a 128 MB operator budget adapts detail without rejecting camera input", async ({
  page,
}) => {
  test.setTimeout(120000);
  await page.route("**/viewer-config.json", (route) =>
    route.fulfill({
      json: { memory_budget_bytes: 128000000 },
    }),
  );
  await page.goto("/?lod=/maps/lod-fixture/lod.json&players=off");
  await ready(page);
  for (const scale of [0.12, 6, 0.5, 4, 0.12]) {
    await page.evaluate(
      (scale) => window.__map.zoom(scale / window.__map.state().scale),
      scale,
    );
    await ready(page);
    const state = await page.evaluate(() => window.__map.state());
    expect(state.scale).toBeCloseTo(scale);
    expect(state.lod!.memory.limitBytes).toBe(128000000);
    expect(state.lod!.memory.peakBytes).toBeLessThanOrEqual(128000000);
    expect(state.lod!.failures).toEqual([]);
    await nonblank(page);
  }
});
