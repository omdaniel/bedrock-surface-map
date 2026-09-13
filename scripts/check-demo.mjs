import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { PNG } from "pngjs";
import { serveDemo } from "./serve-demo.mjs";
const server = process.env.DEMO_SELF_SERVE ? await serveDemo() : null;
const url =
  process.env.DEMO_URL ??
  (server
    ? "http://127.0.0.1:5190/bedrock-surface-map/"
    : "http://127.0.0.1:5180/bedrock-surface-map/");
const output = ".local/demo-evidence";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  channel: process.env.CI ? undefined : "chrome",
  headless: !process.env.CI,
  args: process.env.CI
    ? [
        "--enable-unsafe-webgpu",
        "--enable-features=Vulkan",
        "--use-angle=vulkan",
        "--use-vulkan=swiftshader",
        "--use-webgpu-adapter=swiftshader",
        "--disable-vulkan-surface",
      ]
    : [],
});
let activePage;
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
  });
  activePage = page;
  const errors = [],
    requests = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const responses = [];
  page.on("response", (r) =>
    responses.push(
      r
        .body()
        .then((b) => b.length)
        .catch(() => 0),
    ),
  );
  page.on("request", (r) => requests.push(r.url()));
  await page.clock.install();
  await page.goto(url);
  await page.waitForFunction(
    () =>
      window.__map?.ready &&
      window.__map.state().cached > 0 &&
      window.__map.state().pending === 0,
    {},
    { timeout: 90000 },
  );
  await page.waitForSelector(".player-marker");
  await page.getByRole("button", { name: "Pause demo", exact: true }).click();
  await page.waitForTimeout(2400);
  const initial = await page.evaluate(() => window.__map.state());
  const initialHttpBodyBytes = (await Promise.all(responses)).reduce(
    (a, b) => a + b,
    0,
  );
  assert.equal(await page.locator(".player-marker").count(), 2);
  assert.match(await page.locator(".players-status").innerText(), /fictional/);
  const png = PNG.sync.read(await page.locator("canvas").screenshot());
  const pickSite = async (height, material) => {
    const box = await page.locator("canvas").boundingBox();
    await page.mouse.move(
      box.x + box.width / 2 + 1,
      box.y + box.height / 2 + 1,
    );
    assert.equal(
      await page.locator("#block-pos").innerText(),
      `-106 / ${height} / -52`,
    );
    assert.equal(await page.locator("#block-name").textContent(), material);
  };
  const changedSitePixels = (a, b) => {
    let changed = 0;
    for (let y = Math.floor(a.height / 2) - 12; y < a.height / 2 + 12; y++) {
      for (let x = Math.floor(a.width / 2) - 12; x < a.width / 2 + 12; x++) {
        const i = (y * a.width + x) * 4;
        if (!a.data.subarray(i, i + 3).equals(b.data.subarray(i, i + 3)))
          changed++;
      }
    }
    return changed;
  };
  await pickSite(64, "sand");
  const colors = new Set();
  for (let i = 0; i < png.data.length; i += 64)
    colors.add(png.data.subarray(i, i + 3).toString("hex"));
  assert.ok(colors.size > 100, `blank canvas: ${colors.size}`);
  await page.screenshot({ path: `${output}/desktop.png` });
  const draws = (await page.evaluate(() => window.__map.state())).draws;
  await page.getByRole("button", { name: "Play demo", exact: true }).click();
  await page.clock.fastForward(5000);
  await page.waitForTimeout(400);
  assert.equal(
    (await page.evaluate(() => window.__map.state())).draws,
    draws,
    "player-only redraw",
  );
  const pos = await page.locator(".player-detail").first().innerText();
  await page.clock.fastForward(11000);
  await page.waitForTimeout(1000);
  await page.waitForFunction(
    () => window.__map.state().terrain.changedChunks > 0,
  );
  const built = await page.evaluate(() => window.__map.state());
  await pickSite(67, "oak planks");
  const builtPixels = PNG.sync.read(await page.locator("canvas").screenshot());
  assert.ok(
    changedSitePixels(png, builtPixels) > 100,
    "construction appears in terrain pixels",
  );
  assert.notEqual(
    await page.locator(".player-detail").first().innerText(),
    pos,
  );
  await page.screenshot({ path: `${output}/construction.png` });
  await page.clock.fastForward(16000);
  await page.waitForTimeout(1000);
  const opened = await page.evaluate(() => window.__map.state());
  assert.ok(opened.terrain.revision > built.terrain.revision);
  await pickSite(64, "sand");
  const openedPixels = PNG.sync.read(await page.locator("canvas").screenshot());
  assert.ok(
    changedSitePixels(builtPixels, openedPixels) > 25,
    "removal changes terrain pixels",
  );
  await page.screenshot({ path: `${output}/removal.png` });
  for (let n = 0; n < 6; n++) {
    await page.clock.fastForward(15000);
    await page.waitForTimeout(300);
  }
  const looped = await page.evaluate(() => window.__map.state());
  assert.ok(looped.terrain.revision >= 9, "two loops");
  await page.getByRole("button", { name: "Restart demo", exact: true }).click();
  await page.clock.fastForward(2100);
  await page.waitForTimeout(500);
  assert.ok(
    (await page.evaluate(() => window.__map.state())).terrain.revision >
      looped.terrain.revision,
  );
  await page.getByRole("button", { name: "Follow Rowan", exact: true }).click();
  await page.clock.fastForward(2100);
  await page.waitForTimeout(400);
  const following = await page.evaluate(() => window.__map.state());
  await page.mouse.move(400, 300);
  await page.mouse.down();
  await page.mouse.move(470, 340, { steps: 6 });
  await page.mouse.up();
  const manual = await page.evaluate(() => window.__map.state());
  assert.notEqual(manual.cx, following.cx, "pointer navigation moves camera");
  await page.clock.fastForward(2100);
  await page.waitForTimeout(400);
  assert.equal(
    (await page.evaluate(() => window.__map.state())).cx,
    manual.cx,
    "manual navigation cancels follow",
  );
  // Exercise keyboard playback as well as the pointer controls above. Focus does
  // not depend on compositor stability after software-GPU pan/follow draws.
  await page.getByRole("button", { name: "Pause demo", exact: true }).focus();
  await page.keyboard.press("Enter");
  assert.equal(
    await page.locator("#demo-play").getAttribute("aria-label"),
    "Play demo",
  );
  const paused = await page.locator("#demo-time").innerText();
  await page.clock.fastForward(20000);
  assert.equal(await page.locator("#demo-time").innerText(), paused);
  await page.setViewportSize({ width: 420, height: 900 });
  await page.getByRole("button", { name: "Players", exact: true }).click();
  await page.screenshot({ path: `${output}/mobile.png` });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  for (const request of requests) {
    assert.equal(new URL(request).origin, new URL(url).origin);
    assert.ok(new URL(request).pathname.startsWith(new URL(url).pathname));
    assert.ok(!request.includes("/api/"));
  }
  assert.deepEqual(errors, []);
  const transfer = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .reduce((n, r) => n + r.encodedBodySize, 0),
  );
  const result = {
    initialHttpBodyBytes,
    initial,
    built,
    opened,
    looped,
    colors: colors.size,
    encodedResourceBytes: transfer,
    errors,
    requestCount: requests.length,
  };
  await writeFile(`${output}/chrome.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  const noGpu = await browser.newPage();
  await noGpu.addInitScript(() =>
    Object.defineProperty(navigator, "gpu", { value: undefined }),
  );
  await noGpu.goto(url);
  await noGpu.waitForSelector(".demo-poster");
  await noGpu.waitForFunction(
    () => document.querySelector(".demo-poster").naturalWidth > 0,
  );
  assert.match(await noGpu.locator("#message-text").innerText(), /WebGPU/);
  const reduced = await browser.newPage({ reducedMotion: "reduce" });
  await reduced.goto(url);
  await reduced.waitForSelector('#demo-play[aria-label="Play demo"]', {
    timeout: 90000,
  });
} catch (error) {
  console.error(
    "Demo failure state:",
    await activePage
      ?.evaluate(() => ({
        hidden: document.hidden,
        time: document.querySelector("#demo-time")?.textContent,
        map: window.__map?.state(),
      }))
      .catch(() => "page unavailable"),
  );
  await activePage
    ?.screenshot({ path: `${output}/failure.png`, timeout: 5000 })
    .catch(() => {});
  throw error;
} finally {
  await browser.close();
  if (server) await new Promise((ok) => server.close(ok));
}
