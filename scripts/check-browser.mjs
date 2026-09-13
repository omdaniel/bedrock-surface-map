import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
const browser = await chromium.launch({ channel: "chrome", headless: false });
try {
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1176 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => {
    errors.push(String(e));
    console.error(e);
  });
  page.on("console", (m) => {
    if (m.type() === "error") {
      errors.push(m.text());
      console.error(m.text());
    }
  });
  await page.goto("http://127.0.0.1:5173");
  await page.waitForFunction(() => window.__map?.ready, {}, { timeout: 90000 });
  await page.waitForFunction(
    () => window.__map.state().cached > 0 && window.__map.state().pending === 0,
    {},
    { timeout: 90000 },
  );
  await mkdir(".local/verification", { recursive: true });
  await page.screenshot({ path: ".local/verification/chrome-overview.png" });
  const overview = await page.evaluate(() => window.__map.state());
  await page.evaluate(() => window.__map.spawn());
  await page.waitForFunction(() => window.__map.state().pending === 0);
  await page.mouse.move(960, 600);
  await page.screenshot({ path: ".local/verification/chrome-detail.png" });
  const timings = await page.evaluate(() => window.__map.measure());
  const state = await page.evaluate(() => window.__map.state());
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.__map.fit());
  await page.screenshot({
    path: ".local/verification/chrome-mobile-layout.png",
  });
  const report = {
    browser: await browser.version(),
    overview,
    state,
    timings,
    errors,
  };
  await writeFile(
    ".local/verification/chrome.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
  if (errors.length) process.exitCode = 1;
} finally {
  await browser.close();
}
