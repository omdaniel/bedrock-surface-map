import { expect, test, type Page } from "@playwright/test";
const view = "/?map=/maps/coast/manifest.json&players=off";
test("operator disk quota also applies to explicit offline map URLs", async ({
  page,
}) => {
  await page.route("**/viewer-config.json", (route) =>
    route.fulfill({ json: { local_map: { maxBytes: 1 } } }),
  );
  await page.goto(view);
  await expect(page.locator("#message-text")).toContainText("quota");
  expect(await page.evaluate(() => window.__map.state().draws)).toBe(0);
});
async function settled(page: Page, stride: number) {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const s = window.__map?.state();
          return (
            s && {
              stride: s.stride,
              complete: s.visibleReady === s.visible,
              busy: s.pending || s.terrain?.busy || s.switchingResolution,
              drawn: s.firstVisible !== null,
              local: s.localMap?.phase,
            }
          );
        }),
      { timeout: 45000 },
    )
    .toEqual({
      stride,
      complete: true,
      busy: false,
      drawn: true,
      local: "ready",
    });
}

test("one uniform local resolution replaces the whole view without network reads or layout changes", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(view);
  await settled(page, 1);
  const geometry = () => page.locator("main").boundingBox();
  const bounds = await geometry();
  let remoteReads = 0;
  await page.route("**/maps/coast/**", (route) => {
    remoteReads++;
    return route.abort();
  });
  for (const [scale, stride] of [
    [0.4, 2],
    [3, 1],
    [0.2, 2],
    [2, 1],
  ]) {
    await page.evaluate(
      (scale) => window.__map.zoom(scale / window.__map.state().scale),
      scale,
    );
    await settled(page, stride);
    const state = await page.evaluate(() => window.__map.state());
    expect(state.memory + state.reservedMemory).toBeLessThanOrEqual(
      256 * 1024 ** 2,
    );
    expect(state.failures).toEqual([]);
    expect(await geometry()).toEqual(bounds);
  }
  await page.evaluate(() => window.__map.pan(150, 100));
  await settled(page, 1);
  expect(remoteReads).toBe(0);
  expect(errors).toEqual([]);
});

test("local compressed terrain survives a reload and is decoded at native close-up resolution", async ({
  page,
}) => {
  await page.goto(view);
  await settled(page, 1);
  let remoteReads = 0;
  await page.route("**/maps/coast/regions/**", (route) => {
    remoteReads++;
    return route.abort();
  });
  await page.reload();
  await settled(page, 1);
  await page.evaluate(() => window.__map.zoom(5 / window.__map.state().scale));
  await settled(page, 1);
  expect(remoteReads).toBe(0);
  const state = await page.evaluate(() => window.__map.state());
  expect(state.bufferPadding).toBeGreaterThanOrEqual(256);
  expect(state.cached).toBeGreaterThanOrEqual(state.visible);
});
