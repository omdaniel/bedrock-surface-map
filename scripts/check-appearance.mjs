import {
  verificationConfig,
  waitForMap,
  aimView,
} from "./verification-config.mjs";
import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";

const config = verificationConfig({ output: ".local/appearance" });
const browser = await chromium.launch({ channel: "chrome", headless: false });
try {
  const page = await browser.newPage({
    viewport: { width: 768, height: 864 },
    deviceScaleFactor: 1,
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(config.url);
  await waitForMap(page, config);
  await aimView(page, config);
  await page.waitForFunction(() => window.__map.state().pending === 0);
  await page
    .getByRole("button", { name: "Block borders", exact: true })
    .click();
  await mkdir(config.output, { recursive: true });
  const results = [];
  for (const elevation of [45, 60, 30]) {
    await page
      .getByRole("button", { name: "Lighting and color", exact: true })
      .click();
    const slider = page.getByLabel("Sun elevation");
    await slider.press("Home");
    for (let n = 15; n < elevation; n += 5) await slider.press("ArrowRight");
    await page
      .getByRole("button", { name: "Lighting and color", exact: true })
      .click();
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await page
      .locator("canvas")
      .screenshot({ path: `${config.output}/beach-${elevation}.png` });
    results.push(await page.evaluate(() => window.__map.state()));
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "Lighting and color", exact: true })
    .click();
  await page.screenshot({ path: config.output + "/mobile-controls.png" });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > innerWidth,
  );
  await writeFile(
    config.output + "/report.json",
    JSON.stringify({ results, overflow, errors }, null, 2),
  );
  await writeFile(
    config.output + "/index.html",
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Surface lighting comparison</title><style>*{box-sizing:border-box}body{margin:0;background:#f2f4f5;color:#222;font:14px system-ui}header{padding:16px}h1{font-size:20px;margin:0 0 8px}main{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;background:#c7cdd0}figure{margin:0;background:white}figcaption{padding:12px;font-weight:600}img{display:block;width:100%;aspect-ratio:1}a{color:#176399}@media(max-width:800px){main{grid-template-columns:1fr}}</style>
<header><h1>Terrain light and color</h1><p>Configured view. Northwest sun; wgpu shadow strength 55%, vivid colors.</p><a href="${config.url}">Interactive viewer</a></header>
<main><figure><figcaption>wgpu, 45 degrees</figcaption><img src="beach-45.png" alt="Beach with 45-degree sun"></figure><figure><figcaption>wgpu, 60 degrees</figcaption><img src="beach-60.png" alt="Beach with 60-degree sun"></figure><figure><figcaption>uNmINeD reference</figcaption><img src="unmined-beach.png" alt="uNmINeD beach reference"></figure></main></html>`,
  );
  if (overflow || errors.length)
    throw new Error(JSON.stringify({ overflow, errors }));
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
}
