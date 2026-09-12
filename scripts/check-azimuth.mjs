import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";

const browser = await chromium.launch({ channel: "chrome", headless: false });
try {
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1176 },
    deviceScaleFactor: 1,
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto("http://127.0.0.1:5173/");
  await page.waitForFunction(
    () => window.__map?.ready && window.__map.state().pending === 0,
    {},
    { timeout: 90000 },
  );
  await page.evaluate(() => {
    const s = window.__map.state();
    window.__map.pan(-284 - s.cx, -114 - s.cz);
    window.__map.zoom(4 / s.scale);
  });
  await page
    .getByRole("button", { name: "Block borders", exact: true })
    .click();
  await mkdir(".local/azimuth", { recursive: true });
  const results = [];
  for (const angle of [0, 90, 135, 217, 270, 360]) {
    await page
      .getByRole("button", { name: "Lighting and color", exact: true })
      .click();
    await page.getByLabel("Sun azimuth").evaluate((el, value) => {
      el.value = String(value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, angle);
    await page
      .getByRole("button", { name: "Lighting and color", exact: true })
      .click();
    await page
      .locator("canvas")
      .screenshot({ path: `.local/azimuth/beach-${angle}.png` });
    const timing = await page.evaluate(() => window.__map.measure());
    results.push({
      angle,
      state: await page.evaluate(() => window.__map.state()),
      timing,
    });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "Lighting and color", exact: true })
    .click();
  await page.screenshot({ path: ".local/azimuth/mobile-controls.png" });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > innerWidth,
  );
  const report = {
    browser: await browser.version(),
    results,
    errors,
    overflow,
  };
  await writeFile(
    ".local/azimuth/report.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
  if (errors.length || overflow) process.exitCode = 1;
} finally {
  await browser.close();
}
