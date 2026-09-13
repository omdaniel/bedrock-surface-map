import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";

// Fixed world-space crops make visual references comparable without pixel oracles.
const areas = [
  { name: "origin-1000", x: 0, z: 0, blocks: 1000 },
  { name: "islands-256", x: -160, z: -64, blocks: 256 },
  { name: "river-256", x: -256, z: 336, blocks: 256 },
];
const browser = await chromium.launch({ channel: "chrome", headless: false });
try {
  const page = await browser.newPage({
    viewport: { width: 1000, height: 1096 },
    deviceScaleFactor: 1,
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("http://127.0.0.1:5173");
  await page.waitForFunction(() => window.__map?.ready, {}, { timeout: 90000 });
  await mkdir(".local/comparison", { recursive: true });
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
      .screenshot({ path: `.local/comparison/wgpu-${area.name}.png` });
    results.push({
      ...area,
      state: await page.evaluate(() => window.__map.state()),
    });
  }
  await writeFile(
    ".local/comparison/wgpu.json",
    JSON.stringify(
      { browser: await browser.version(), results, errors },
      null,
      2,
    ),
  );
  await writeFile(
    ".local/comparison/index.html",
    `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bedrock map comparison</title><style>
*{box-sizing:border-box}body{margin:0;background:#f4f5f6;color:#20252a;font:14px system-ui}
header{padding:16px 20px;border-bottom:1px solid #cbd1d6}h1{font-size:20px;margin:0 0 8px}
p{margin:6px 0}main{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:#cbd1d6}
figure{margin:0;background:white;min-width:0}figcaption{padding:12px;font-weight:600}
img{display:block;width:100%;aspect-ratio:1}a{color:#176399}
@media(max-width:700px){main{grid-template-columns:1fr}}
</style><header><h1>Bedrock Survival: visual comparison</h1>
<p>X/Z -500 to +500, north up. Same offline snapshot; appearance reference, not a pixel oracle.</p>
<p><a href="http://127.0.0.1:5173/">Interactive wgpu viewer</a> &middot;
<a href="https://bedrockmap.net/map/world-416">User's BedrockMap reference</a></p></header>
<main><figure><figcaption>wgpu prototype</figcaption><img src="wgpu-origin-1000.png" alt="Textured wgpu surface map"></figure>
<figure><figcaption>uNmINeD 0.20.8-dev</figcaption><img src="unmined-origin-1000.png" alt="uNmINeD reference of the same coordinates"></figure></main></html>`,
  );
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
}
