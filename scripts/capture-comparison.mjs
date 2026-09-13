import { verificationConfig, waitForMap } from "./verification-config.mjs";
import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";

const config = verificationConfig({ output: ".local/comparison" });
const areas = config.areas ?? [
  { name: "origin-1000", x: 0, z: 0, blocks: 1000 },
];
if (
  !Array.isArray(areas) ||
  areas.length < 1 ||
  areas.length > 16 ||
  !areas.every(
    (v) =>
      v &&
      /^[A-Za-z0-9_-]{1,80}$/.test(v.name) &&
      [v.x, v.z, v.blocks].every(Number.isFinite) &&
      v.blocks > 0 &&
      v.blocks <= 4096,
  )
)
  throw Error(
    "Configure 1-16 comparison areas with name, x, z and positive blocks <=4096",
  );
const browser = await chromium.launch({ channel: "chrome", headless: false });
try {
  const page = await browser.newPage({
    viewport: { width: 1000, height: 1096 },
    deviceScaleFactor: 1,
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(config.url);
  await waitForMap(page, config);
  await mkdir(config.output, { recursive: true });
  const results = [];
  for (const area of areas) {
    await page.evaluate(({ x, z, blocks }) => {
      const s = window.__map.state();
      window.__map.pan(x - s.cx, z - s.cz);
      window.__map.zoom(1000 / blocks / s.scale);
    }, area);
    await page.waitForFunction(
      () =>
        window.__map.state().pending === 0 &&
        window.__map.state().firstVisible !== null,
      {},
      { timeout: 90000 },
    );
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await page
      .locator("canvas")
      .screenshot({ path: `${config.output}/wgpu-${area.name}.png` });
    results.push({
      ...area,
      state: await page.evaluate(() => window.__map.state()),
    });
  }
  await writeFile(
    config.output + "/wgpu.json",
    JSON.stringify(
      { browser: await browser.version(), results, errors },
      null,
      2,
    ),
  );
  await writeFile(
    config.output + "/index.html",
    `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bedrock map comparison</title><style>
*{box-sizing:border-box}body{margin:0;background:#f4f5f6;color:#20252a;font:14px system-ui}
header{padding:16px 20px;border-bottom:1px solid #cbd1d6}h1{font-size:20px;margin:0 0 8px}
p{margin:6px 0}main{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:#cbd1d6}
figure{margin:0;background:white;min-width:0}figcaption{padding:12px;font-weight:600}
img{display:block;width:100%;aspect-ratio:1}a{color:#176399}
@media(max-width:700px){main{grid-template-columns:1fr}}
</style><header><h1>Surface map: visual comparison</h1>
<p>Match the configured crop and offline snapshot in both renderers; appearance reference, not a pixel oracle.</p>
<p><a href="${config.url}">Interactive wgpu viewer</a></p></header>
<main><figure><figcaption>wgpu prototype</figcaption><img src="wgpu-${areas[0].name}.png" alt="Textured wgpu surface map"></figure>
<figure><figcaption>uNmINeD reference</figcaption><img src="unmined-${areas[0].name}.png" alt="uNmINeD reference of the same coordinates"></figure></main></html>`,
  );
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
}
