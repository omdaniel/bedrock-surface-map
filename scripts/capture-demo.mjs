import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
const out = ".local/demo-frames";
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: "chrome" });
try {
  const page = await browser.newPage({
    viewport: { width: 1000, height: 700 },
    deviceScaleFactor: 1,
  });
  await page.clock.install();
  await page.goto("http://127.0.0.1:5180/bedrock-surface-map/");
  await page.waitForFunction(
    () => window.__map?.ready && window.__map.state().pending === 0,
  );
  await page.waitForSelector("#demo-play");
  await page.getByRole("button", { name: "Restart demo", exact: true }).click();
  await page.evaluate(() => window.__map.zoom(2));
  await page.getByRole("button", { name: "Players", exact: true }).click();
  for (let i = 0; i < 60; i++) {
    await page.clock.fastForward(1000);
    await page.waitForFunction(
      () =>
        !window.__map.state().terrain.busy &&
        window.__map.state().pending === 0,
    );
    await page.waitForTimeout(100);
    await page.screenshot({ path: `${out}/${String(i).padStart(3, "0")}.png` });
  }
} finally {
  await browser.close();
}
const result = spawnSync(
  "ffmpeg",
  [
    "-y",
    "-framerate",
    "6",
    "-i",
    `${out}/%03d.png`,
    "-filter_complex",
    "split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3",
    "-loop",
    "0",
    ".local/demo-release/demo.gif",
  ],
  { stdio: "inherit" },
);
if (result.status !== 0) process.exit(result.status ?? 1);
