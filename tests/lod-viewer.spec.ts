import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PNG } from "pngjs";

const directory = resolve(".local/lod-browser");
const root = () =>
  JSON.parse(readFileSync(resolve(directory, "lod.json"), "utf8"));
async function settle(page: Page) {
  await page.waitForFunction(
    () => {
      const state = window.__map?.state();
      return (
        state?.lod &&
        !state.lod.pending &&
        !state.lod.queued &&
        !state.renderPending &&
        state.lod.cut.length > 0
      );
    },
    undefined,
    { timeout: 60000 },
  );
}
async function mount(page: Page, prefix = "/pyramid") {
  await page.route("**/viewer-config.json", (r) =>
    r.fulfill({ json: { lod_url: `${prefix}/lod.json` } }),
  );
  await page.route(`**${prefix}/**`, (r) => {
    const name = new URL(r.request().url()).pathname.split("/").at(-1)!;
    if (name === "lod.json") return r.fulfill({ json: root() });
    if (!/^[a-f0-9]{64}\.[a-z0-9]+$/.test(name))
      return r.fulfill({ status: 404 });
    return r.fulfill({
      body: readFileSync(resolve(directory, "objects", name)),
      contentType: name.endsWith(".json")
        ? "application/json"
        : name.endsWith(".png")
          ? "image/png"
          : "application/octet-stream",
    });
  });
  await page.goto("/?players=off");
  await page.waitForFunction(() => window.__map?.ready);
  await settle(page);
}
test("encoded hierarchy renders, refines, buffers a pan, and stops drawing when idle", async ({
  page,
}) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await mount(page);
  const fit = await page.evaluate(() => window.__map.state());
  expect(fit.lod!.stride).toBeGreaterThan(1);
  expect(fit.lod!.memory + fit.lod!.reserve).toBeLessThanOrEqual(
    256 * 1024 * 1024,
  );
  const image = PNG.sync.read(await page.locator("#map").screenshot());
  let colored = 0;
  for (let i = 0; i < image.data.length; i += 4)
    if (
      Math.max(image.data[i], image.data[i + 1], image.data[i + 2]) -
        Math.min(image.data[i], image.data[i + 1], image.data[i + 2]) >
      30
    )
      colored++;
  expect(colored / (image.width * image.height)).toBeGreaterThan(0.1);
  await page.evaluate(() => window.__map.spawn());
  await settle(page);
  expect((await page.evaluate(() => window.__map.state())).lod!.level).toBe(0);
  const close = await page.evaluate(() => window.__map.state());
  // Network failure must not delay already-buffered visible data. New speculative
  // requests are allowed; those are not prerequisites for this camera frame.
  await page.route("**/pyramid/objects/*", (r) => r.abort());
  await page.evaluate(() => window.__map.pan(16, 0));
  await expect
    .poll(() => page.evaluate(() => window.__map.state().draws))
    .toBeGreaterThan(close.draws);
  const moved = await page.evaluate(() => window.__map.state());
  expect(moved.cx).toBe(close.cx + 16);
  expect(moved.lod!.lastPanHit).toBe(true);
  expect(moved.lod!.cut.every((t) => t.key.level === 0)).toBe(true);
  await page.unroute("**/pyramid/objects/*");
  await settle(page);
  const draws = (await page.evaluate(() => window.__map.state())).draws;
  await page.waitForTimeout(2400);
  expect((await page.evaluate(() => window.__map.state())).draws).toBe(draws);
  expect(errors).toEqual([]);
});

test("zoom reversals retain coarse coverage and preserve sunlight and camera", async ({
  page,
}) => {
  test.setTimeout(120000);
  await mount(page);
  await page.evaluate(() => {
    (window as any).blankCuts = 0;
    (window as any).watchCuts = true;
    const step = () => {
      if (!(window as any).watchCuts) return;
      if (!window.__map.state().lod?.cut.length) (window as any).blankCuts++;
      requestAnimationFrame(step);
    };
    step();
  });
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.__map.spawn());
    await page.waitForTimeout(200);
    await page.evaluate(() => window.__map.fit());
    await page.waitForTimeout(200);
  }
  await settle(page);
  expect(
    await page.evaluate(() => {
      (window as any).watchCuts = false;
      return (window as any).blankCuts;
    }),
  ).toBe(0);
  await page
    .getByRole("button", { name: "Lighting and color", exact: true })
    .click();
  const before = await page.evaluate(() => window.__map.state());
  await page.locator("#elevation").evaluate((e: HTMLInputElement) => {
    e.value = "15";
    e.dispatchEvent(new Event("input"));
  });
  await settle(page);
  const after = await page.evaluate(() => window.__map.state());
  expect(after.cx).toBe(before.cx);
  expect(after.cz).toBe(before.cz);
  expect(after.scale).toBe(before.scale);
  expect(after.elevation).toBe(15);
  expect(after.lod!.highWater).toBeLessThanOrEqual(256 * 1024 * 1024);
});

test("persistent immutable objects reduce reload downloads and changed roots revalidate", async ({
  page,
}) => {
  test.setTimeout(120000);
  let downloads = 0;
  page.on("request", (r) => {
    if (r.url().includes("/pyramid/objects/")) downloads++;
  });
  await mount(page);
  await page.evaluate(() => window.__map.spawn());
  await settle(page);
  await page.waitForTimeout(300);
  const coldDownloads = downloads;
  downloads = 0;
  await page.reload();
  await page.waitForFunction(() => window.__map?.ready);
  await settle(page);
  await page.evaluate(() => window.__map.spawn());
  await settle(page);
  expect((await page.evaluate(() => window.__map.state())).lod!.level).toBe(0);
  // Storage is best effort; resident panning with a failed network is tested
  // separately. Reloading does not promise a completely offline world.
  expect(downloads).toBeLessThan(coldDownloads / 2);
  const revision = root();
  revision.revision++;
  await page.route("**/pyramid/lod.json", (r) => r.fulfill({ json: revision }));
  await expect
    .poll(() => page.evaluate(() => window.__map.state().lod?.revision), {
      timeout: 10000,
    })
    .toBe(revision.revision);
  await settle(page);
  const result = (await page.evaluate(() => window.__map.state())).lod!;
  expect({ error: result.error, failures: result.failures }).toEqual({
    error: "",
    failures: [],
  });
});

test("published edits update exact picking and recover after missing objects without reload", async ({
  page,
}) => {
  test.setTimeout(120000);
  const live = resolve(".local/lod-live");
  const stages = [0, 1, 2].map((i) =>
    JSON.parse(readFileSync(resolve(live, `stage${i}.json`), "utf8")),
  );
  let stage = 0,
    outage = false;
  await page.route("**/viewer-config.json", (r) =>
    r.fulfill({ json: { lod_url: "/live/lod.json" } }),
  );
  await page.route("**/live/**", (r) => {
    const name = new URL(r.request().url()).pathname.split("/").at(-1)!;
    if (name === "lod.json") return r.fulfill({ json: stages[stage] });
    if (outage) return r.fulfill({ status: 503 });
    if (!/^[a-f0-9]{64}\.[a-z0-9]+$/.test(name))
      return r.fulfill({ status: 404 });
    return r.fulfill({
      body: readFileSync(resolve(live, "objects", name)),
      contentType: name.endsWith(".json")
        ? "application/json"
        : name.endsWith(".png")
          ? "image/png"
          : "application/octet-stream",
    });
  });
  await page.goto("/?players=off");
  await page.waitForFunction(() => window.__map?.ready);
  await page.evaluate(() => {
    const s = window.__map.state();
    window.__map.pan(8 - s.cx, 8 - s.cz);
    window.__map.zoom(5 / s.scale);
  });
  await settle(page);
  const sample = async () => {
    const box = await page.locator("#map").boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    return page.locator("#block-pos").textContent();
  };
  await expect.poll(sample).toContain("/ 64.0 /");
  const before = await page.evaluate(() => window.__map.state());
  stage = 1;
  await expect.poll(sample, { timeout: 15000 }).toContain("/ 96.0 /");
  await settle(page);
  const edited = await page.evaluate(() => window.__map.state());
  expect(edited.cx).toBe(before.cx);
  expect(edited.cz).toBe(before.cz);
  expect(edited.scale).toBe(before.scale);
  stage = 2;
  outage = true;
  await expect
    .poll(() => page.evaluate(() => window.__map.state().lod?.error), {
      timeout: 15000,
    })
    .not.toBe("");
  expect(await sample()).toContain("/ 96.0 /");
  outage = false;
  await expect.poll(sample, { timeout: 30000 }).toContain("/ 128.0 /");
  await settle(page);
  expect((await page.evaluate(() => window.__map.state())).lod!.error).toBe("");
});

test("live hierarchy keeps producer freshness separate from successful root polling", async ({
  page,
}) => {
  const live = resolve(".local/lod-live"),
    root = JSON.parse(readFileSync(resolve(live, "stage0.json"), "utf8"));
  let status = "stale";
  await page.route("**/viewer-config.json", (r) =>
    r.fulfill({
      json: {
        lod_url: "/live/lod.json",
        terrain: {
          url: "/live/manifest.json",
          world_id: root.world_id,
          generation: root.generation,
        },
      },
    }),
  );
  await page.route("**/live/**", (r) => {
    const name = new URL(r.request().url()).pathname.split("/").at(-1)!;
    if (name === "lod.json") return r.fulfill({ json: root });
    if (name === "status")
      return r.fulfill({
        json: {
          world_id: root.world_id,
          generation: root.generation,
          status,
          lod: { status: "live" },
        },
      });
    if (!/^[a-f0-9]{64}\.[a-z0-9]+$/.test(name))
      return r.fulfill({ status: 404 });
    return r.fulfill({
      body: readFileSync(resolve(live, "objects", name)),
      contentType: name.endsWith(".png")
        ? "image/png"
        : "application/octet-stream",
    });
  });
  await page.goto("/?players=off");
  await page.waitForFunction(() => window.__map?.ready);
  await settle(page);
  await expect(page.locator(".local-state")).toContainText("Terrain stale", {
    timeout: 10000,
  });
  const before = (await page.evaluate(() => window.__map.state())).draws;
  status = "live";
  await expect(page.locator(".local-state")).toContainText("Terrain live", {
    timeout: 10000,
  });
  expect((await page.evaluate(() => window.__map.state())).draws).toBe(before);
});
