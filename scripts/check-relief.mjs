import {
  verificationConfig,
  waitForMap,
  aimView,
} from "./verification-config.mjs";
import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { PNG } from "pngjs";
import { setSunAzimuth } from "./browser-controls.mjs";

const config = verificationConfig({ output: ".local/relief" });
const browser = await chromium.launch({ channel: "chrome", headless: false });
try {
  const page = await browser.newPage({
    viewport: { width: 768, height: 864 },
    deviceScaleFactor: 1,
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(config.url);
  await waitForMap(page, config);
  const initial = await page.evaluate(() => window.__map.state());
  const controls = page.getByRole("button", {
    name: "Lighting and color",
    exact: true,
  });
  const set = async (label, value) => {
    await controls.click();
    if (label === "Sun azimuth") await setSunAzimuth(page, value);
    else
      await page.getByLabel(label).evaluate((el, v) => {
        el.value = String(v);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }, value);
    await controls.click();
  };
  await page
    .getByRole("button", { name: "Block borders", exact: true })
    .click();
  await set("Sun azimuth", 330);
  await mkdir(config.output, { recursive: true });
  const captures = [];
  const capture = async (name) => {
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const bytes = await page.locator("canvas").screenshot({
      path: `${config.output}/${name}.png`,
      style: "#scale,.north,.zoom,#inspect {visibility:hidden}",
    });
    const png = PNG.sync.read(bytes);
    const colors = new Set();
    for (let i = 0; i < png.data.length; i += 80)
      colors.add(png.data.subarray(i, i + 3).toString("hex"));
    if (colors.size < 100)
      throw new Error(`Blank or suspicious canvas: ${name}`);
    captures.push({
      name,
      colors: colors.size,
      state: await page.evaluate(() => window.__map.state()),
    });
  };
  await aimView(page, config);
  await set("Terrain relief", 0);
  await capture("beach-before");
  await set("Terrain relief", 100);
  await capture("beach-after");
  await set("Sun azimuth", 150);
  await capture("beach-opposite");
  await set("Sun azimuth", 330);
  await aimView(page, config, "detailView", 16);
  await set("Terrain relief", 0);
  await capture("close-before");
  await set("Terrain relief", 100);
  await capture("close-after");
  await set("Sun azimuth", 150);
  await capture("close-opposite");
  await page.setViewportSize({ width: 1920, height: 1176 });
  await aimView(page, config);
  const measurements = [];
  for (const angle of [330, 150]) {
    await set("Sun azimuth", angle);
    for (const strength of [0, 100]) {
      await set("Terrain relief", strength);
      const timing = await page.evaluate(() => window.__map.measure());
      measurements.push({
        angle,
        strength,
        timing,
        state: await page.evaluate(() => window.__map.state()),
      });
    }
  }
  await set("Sun azimuth", 330);
  await controls.click();
  await page.screenshot({ path: config.output + "/desktop-controls.png" });
  const layouts = [];
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 844, height: 390 },
  ]) {
    await page.setViewportSize(viewport);
    await page.getByLabel("Color treatment").scrollIntoViewIfNeeded();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    );
    const panel = await page.locator("#lighting").boundingBox();
    layouts.push({ viewport, overflow, panel });
    if (overflow || panel.y + panel.height > viewport.height - 30)
      throw new Error("Lighting panel overflow");
    await page.screenshot({
      path: `${config.output}/controls-${viewport.width}.png`,
    });
  }
  const report = {
    azimuthConvention: "north-clockwise",
    browser: await browser.version(),
    initial,
    captures,
    measurements,
    layouts,
    errors,
  };
  await writeFile(
    config.output + "/report.json",
    JSON.stringify(report, null, 2),
  );
  await writeFile(
    config.output + "/index.html",
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Terrain edge relief comparison</title><style>*{box-sizing:border-box}body{margin:0;background:#f2f4f5;color:#222;font:14px system-ui}header{padding:16px}h1{font-size:20px;margin:0 0 8px}main{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;background:#c7cdd0}figure{margin:0;background:white}figcaption{padding:12px;font-weight:600}img{display:block;width:100%;aspect-ratio:1}a{color:#176399}@media(max-width:800px){main{grid-template-columns:1fr}}</style>
<header><h1>Terrain-edge relief</h1><p>Same configured view, with relief off and on. wgpu sun 330 degrees azimuth (clockwise from north), 45 degrees elevation, 55% cast shadows. Relief 100%, quarter-block width. uNmINeD is a visual reference, not an identical lighting model.</p><a href="${config.url}">Interactive viewer</a></header>
<main><figure><figcaption>wgpu: relief off</figcaption><img src="beach-before.png" alt="Beach without local edge relief"></figure><figure><figcaption>wgpu: relief on</figcaption><img src="beach-after.png" alt="Beach with highlighted steps and contact shading"></figure><figure><figcaption>uNmINeD reference</figcaption><img src="../appearance/unmined-beach.png" alt="uNmINeD beach reference"></figure>
<figure><figcaption>16 pixels/block: relief off</figcaption><img src="close-before.png" alt="Unaccented close terrain"></figure><figure><figcaption>16 pixels/block: four-pixel bands</figcaption><img src="close-after.png" alt="Close terrain with scaled relief bands"></figure><figure><figcaption>Same relief, sun rotated to 150 degrees</figcaption><img src="close-opposite.png" alt="Relief and shadows following southeast illumination"></figure></main></html>`,
  );
  console.log(JSON.stringify(report, null, 2));
  if (errors.length) process.exitCode = 1;
} finally {
  await browser.close();
}
