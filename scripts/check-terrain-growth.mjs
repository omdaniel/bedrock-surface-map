import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";

execFileSync(
  "cargo",
  ["run", "--locked", "-p", "surface-sync", "--example", "large_fixture"],
  { stdio: "inherit" },
);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const reports = [];
try {
  for (const factor of [4, 16]) {
    const root = JSON.parse(
      await readFile(`.local/terrain-large/root-${factor}.json`, "utf8"),
    );
    const page = await browser.newPage({
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("**/viewer-config.json", (r) =>
      r.fulfill({
        json: {
          players: null,
          terrain: {
            world_id: root.world_id,
            generation: root.generation,
            url: `/api/v1/worlds/${root.world_id}/terrain/manifest.json`,
          },
        },
      }),
    );
    await page.route("**/api/v1/worlds/*/terrain/**", async (r) => {
      const name = new URL(r.request().url()).pathname.split("/").at(-1);
      if (name === "manifest.json") return r.fulfill({ json: root });
      if (name === "status")
        return r.fulfill({
          json: {
            world_id: root.world_id,
            generation: root.generation,
            status: "live",
            diagnostics: {},
          },
        });
      return r.fulfill({
        body: await readFile(`.local/terrain-large/objects/${name}`),
        contentType: name.endsWith("json")
          ? "application/json"
          : name.endsWith("png")
            ? "image/png"
            : "application/octet-stream",
      });
    });
    const started = performance.now();
    await page.goto("http://127.0.0.1:5173/");
    const settled = () =>
      page.waitForFunction(
        () =>
          window.__map?.ready &&
          window.__map.state().pending === 0 &&
          !window.__map.state().terrain?.busy &&
          window.__map.state().cached > 0,
        null,
        { timeout: 30000 },
      );
    await settled();
    const samples = [],
      cold = performance.now() - started;
    const extent = root.bounds[2] - 384;
    const stops = [-extent, -extent / 2, 0, extent / 2, extent];
    const route = stops.flatMap((z) => stops.map((x) => [x, z]));
    route.push([0, 0]);
    for (const [x, z] of route) {
      await page.evaluate(
        ([x, z]) => {
          const s = window.__map.state();
          window.__map.pan(x - s.cx, z - s.cz);
        },
        [x, z],
      );
      await page.waitForTimeout(750);
      await page.waitForFunction(
        () => {
          const s = window.__map.state(),
            w = s.terrain.window;
          return (
            !s.terrain.busy &&
            w[0] <= s.cx &&
            w[2] > s.cx &&
            w[1] <= s.cz &&
            w[3] > s.cz
          );
        },
        null,
        { timeout: 15000 },
      );
      await settled();
      const s = await page.evaluate(() => window.__map.state());
      assert(s.memory <= 256 * 1024 * 1024, "Map cache exceeded 256 MiB");
      assert(s.cached < root.regions.length, "Whole-world detail was loaded");
      assert.equal(s.failures.length, 0);
      const w = s.terrain.window;
      assert(w[0] <= s.cx && w[2] > s.cx && w[1] <= s.cz && w[3] > s.cz);
      samples.push({ memory: s.memory, cached: s.cached, window: w });
    }
    await page.getByRole("button", { name: "Fit world", exact: true }).click();
    await page.waitForFunction(
      () =>
        document.querySelector("#message")?.textContent?.includes("Zoom in"),
      null,
      { timeout: 15000 },
    );
    await page
      .getByRole("button", { name: "World spawn", exact: true })
      .click();
    await page.waitForTimeout(2500);
    await settled();
    assert.deepEqual(errors, []);
    await mkdir(".local/terrain/verification", { recursive: true });
    await page.screenshot({
      path: `.local/terrain/verification/growth-${factor}x.png`,
    });
    reports.push({
      factor,
      columns: root.regions.length * 65536,
      regions: root.regions.length,
      first_visible_ms: cold,
      samples,
      wide_view_requires_zoom: true,
      recovered: true,
    });
    await page.close();
  }
  await writeFile(
    ".local/terrain/verification/growth.json",
    JSON.stringify(reports, null, 2),
  );
  console.log(JSON.stringify(reports, null, 2));
} finally {
  await browser.close();
}
