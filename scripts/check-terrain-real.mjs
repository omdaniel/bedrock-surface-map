import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const state = resolve(".local/terrain/real-state");
const root = JSON.parse(
  execFileSync(
    "target/release/surface-sync",
    [
      "--state",
      state,
      "--world",
      "bedrock-survival",
      "--generation",
      "bedrock-survival-20260912",
      "manifest",
    ],
    { encoding: "utf8" },
  ),
);
const browser = await chromium.launch({ channel: "chrome", headless: false });
const report = {
  browser: await browser.version(),
  source:
    "offline snapshot through live format; no live-server acceptance implied",
  runs: [],
};
await mkdir(".local/terrain/verification", { recursive: true });
try {
  for (const live of [false, true]) {
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1176 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    if (live) {
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
        const url = new URL(r.request().url());
        if (url.pathname.endsWith("manifest.json"))
          return r.fulfill({ json: root, headers: { ETag: '"fixture"' } });
        if (url.pathname.endsWith("status"))
          return r.fulfill({
            json: {
              world_id: root.world_id,
              generation: root.generation,
              status: "disabled",
              last_repair_ms: 0,
              diagnostics: {},
            },
          });
        const name = url.pathname.split("/").at(-1);
        if (!/^[a-f0-9]{64}\.(json|png|zst)$/.test(name))
          return r.fulfill({ status: 404 });
        return r.fulfill({
          body: await readFile(resolve(state, "objects", name)),
          contentType: name.endsWith("png")
            ? "image/png"
            : name.endsWith("json")
              ? "application/json"
              : "application/octet-stream",
        });
      });
    }
    const start = performance.now();
    await page.goto("http://127.0.0.1:5173/?players=off");
    await page.waitForFunction(
      () =>
        window.__map?.ready &&
        window.__map.state().cached > 0 &&
        window.__map.state().pending === 0,
      {},
      { timeout: 90000 },
    );
    const firstVisible = performance.now() - start;
    await page.screenshot({
      path: `.local/terrain/verification/chrome-${live ? "live" : "offline"}-overview.png`,
    });
    const overview = await page.evaluate(() => window.__map.state());
    await page.evaluate(() => window.__map.spawn());
    await page.waitForTimeout(3000);
    const timings = [];
    for (let i = 0; i < 3; i++)
      timings.push(await page.evaluate(() => window.__map.measure()));
    await page.screenshot({
      path: `.local/terrain/verification/chrome-${live ? "live" : "offline"}-detail.png`,
    });
    report.runs.push({
      live,
      first_visible_ms: firstVisible,
      overview,
      timings,
      errors,
    });
    if (errors.length) throw Error(JSON.stringify(errors));
    await context.close();
  }
  await writeFile(
    ".local/terrain/verification/chrome-real.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
