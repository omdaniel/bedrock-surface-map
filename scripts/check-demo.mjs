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
  // Exercise keyboard playback as well as the pointer controls above.
  await page.getByRole("button", { name: "Pause demo", exact: true }).focus();
  await page.keyboard.press("Enter");
  assert.equal(
    await page.locator("#demo-play").getAttribute("aria-label"),
    "Play demo",
  );
  const paused = await page.locator("#demo-time").innerText();
  await page.clock.fastForward(20000);
  assert.equal(await page.locator("#demo-time").innerText(), paused);
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
  };
  await page.close();

  // Test real-time input in a separate context with native timers. Fast-forwarded
  // requestAnimationFrame scheduling must not drive compositor actionability.
  const ui = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
  });
  activePage = ui;
  ui.on("pageerror", (e) => errors.push(String(e)));
  ui.on("request", (r) => requests.push(r.url()));
  await ui.goto(url);
  await ui.waitForFunction(
    () => window.__map?.ready && window.__map.state().pending === 0,
    {},
    { timeout: 90000 },
  );
  await ui.waitForSelector(".player-marker");
  await ui.getByRole("button", { name: "Follow Rowan", exact: true }).click();
  const centered = await ui.evaluate(() => window.__map.state().cx);
  await ui.getByRole("button", { name: "Play demo", exact: true }).click();
  await ui.waitForFunction((x) => window.__map.state().cx !== x, centered, {
    timeout: 15000,
  });
  const following = await ui.evaluate(() => window.__map.state());
  await ui.mouse.move(400, 300);
  await ui.mouse.down();
  await ui.mouse.move(470, 340, { steps: 6 });
  await ui.mouse.up();
  const manual = await ui.evaluate(() => window.__map.state());
  assert.notEqual(manual.cx, following.cx, "pointer navigation moves camera");
  await ui.waitForTimeout(2600);
  assert.equal(
    (await ui.evaluate(() => window.__map.state())).cx,
    manual.cx,
    "manual navigation cancels follow",
  );
  await ui.getByRole("button", { name: "Pause demo", exact: true }).click();
  await ui.setViewportSize({ width: 420, height: 900 });
  await ui.getByRole("button", { name: "Players", exact: true }).click();
  await ui.screenshot({ path: `${output}/mobile.png` });
  await ui.getByRole("button", { name: "Players", exact: true }).focus();
  await ui.keyboard.press("Enter");
  assert.equal(
    await ui.locator("#players-toggle").getAttribute("aria-expanded"),
    "true",
  );
  await ui.screenshot({ path: `${output}/mobile-roster.png` });
  assert.ok(
    await ui.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  );
  await ui.close();
  const noGpu = await browser.newPage();
  activePage = noGpu;
  noGpu.on("pageerror", (e) => errors.push(String(e)));
  noGpu.on("request", (r) => requests.push(r.url()));
  await noGpu.addInitScript(() =>
    Object.defineProperty(navigator, "gpu", { value: undefined }),
  );
  await noGpu.goto(url);
  await noGpu.waitForSelector(".demo-poster");
  await noGpu.waitForFunction(
    () => document.querySelector(".demo-poster").naturalWidth > 0,
  );
  assert.match(await noGpu.locator("#message-text").innerText(), /WebGPU/);
  await noGpu.close();
  const reduced = await browser.newPage({ reducedMotion: "reduce" });
  activePage = reduced;
  reduced.on("pageerror", (e) => errors.push(String(e)));
  reduced.on("request", (r) => requests.push(r.url()));
  await reduced.goto(url);
  await reduced.waitForSelector('#demo-play[aria-label="Play demo"]', {
    timeout: 90000,
  });
  for (const request of requests) {
    assert.equal(new URL(request).origin, new URL(url).origin);
    assert.ok(new URL(request).pathname.startsWith(new URL(url).pathname));
    assert.ok(!request.includes("/api/"));
  }
  assert.deepEqual(errors, []);
  Object.assign(result, {
    errors,
    requestCount: requests.length,
    nativeTimerInteractions: true,
  });
  await writeFile(`${output}/chrome.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
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
