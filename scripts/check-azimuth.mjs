import {
  verificationConfig,
  waitForMap,
  aimView,
} from "./verification-config.mjs";
import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { setSunAzimuth } from "./browser-controls.mjs";

const config = verificationConfig({ output: ".local/azimuth" });
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
  await page.goto(config.url);
  await waitForMap(page, config);
  await aimView(page, config);
  await page
    .getByRole("button", { name: "Block borders", exact: true })
    .click();
  await mkdir(config.output, { recursive: true });
  const results = [];
  for (const angle of [0, 90, 180, 233, 270, 315, 330, 360]) {
    await page
      .getByRole("button", { name: "Lighting and color", exact: true })
      .click();
    await setSunAzimuth(page, angle);
    await page
      .getByRole("button", { name: "Lighting and color", exact: true })
      .click();
    await page
      .locator("canvas")
      .screenshot({ path: `${config.output}/beach-${angle}.png` });
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
  await page.screenshot({ path: config.output + "/mobile-controls.png" });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > innerWidth,
  );
  const report = {
    azimuthConvention: "north-clockwise",
    browser: await browser.version(),
    results,
    errors,
    overflow,
  };
  await writeFile(
    config.output + "/report.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
  if (errors.length || overflow) process.exitCode = 1;
} finally {
  await browser.close();
}
