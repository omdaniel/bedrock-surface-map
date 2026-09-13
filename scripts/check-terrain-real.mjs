import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { verificationConfig, waitForMap } from "./verification-config.mjs";
const config = verificationConfig({
  output: ".local/terrain/verification",
  options: {
    state: { type: "string" },
    "world-id": { type: "string" },
    generation: { type: "string" },
    cli: { type: "string", default: "target/release/surface-sync" },
  },
});
if (
  !config.state ||
  ![config["world-id"], config.generation].every(
    (v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(v),
  )
)
  throw Error(
    "Configure state, world-id and generation for the derived terrain store",
  );
const state = resolve(config.state);
const root = JSON.parse(
  execFileSync(
    config.cli,
    [
      "--state",
      state,
      "--world",
      config["world-id"],
      "--generation",
      config.generation,
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
await mkdir(config.output, { recursive: true });
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
    const url = new URL(config.url);
    url.searchParams.set("players", "off");
    if (live) {
      url.searchParams.delete("map");
      url.searchParams.delete("terrain");
    } else url.searchParams.set("terrain", "off");
    await page.goto(url.href);
    await waitForMap(page, config);
    const firstVisible = performance.now() - start;
    await page.screenshot({
      path: `${config.output}/chrome-${live ? "live" : "offline"}-overview.png`,
    });
    const overview = await page.evaluate(() => window.__map.state());
    await page.evaluate(() => window.__map.spawn());
    await page.waitForTimeout(3000);
    const timings = [];
    for (let i = 0; i < 3; i++)
      timings.push(await page.evaluate(() => window.__map.measure()));
    await page.screenshot({
      path: `${config.output}/chrome-${live ? "live" : "offline"}-detail.png`,
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
    resolve(config.output, "chrome-real.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
