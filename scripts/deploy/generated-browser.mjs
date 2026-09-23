import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import { PNG } from "pngjs";
import { chromium } from "playwright";

export async function verifyGeneratedBrowser({ port, ca, password }) {
  const rootKey = new X509Certificate(ca).publicKey.export({
    type: "spki",
    format: "der",
  });
  const spki = createHash("sha256").update(rootKey).digest("base64");
  const origin = `https://map.example.test:${port}`;
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--use-angle=swiftshader",
      "--enable-unsafe-webgpu",
      "--no-proxy-server",
      "--host-resolver-rules=MAP map.example.test 127.0.0.1",
      `--ignore-certificate-errors-spki-list=${spki}`,
    ],
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      httpCredentials: { username: "map", password },
    });
    const cases = [];
    for (const suffix of ["/", "/?terrain=off", "/?players=off"]) {
      const page = await context.newPage();
      const requests = [],
        errors = [];
      page.on("request", (request) => requests.push(request.url()));
      page.on("pageerror", (error) => errors.push(error.message));
      try {
        await page.goto(`${origin}${suffix}`, {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
        await page.waitForFunction(
          () =>
            window.__map?.ready &&
            window.__map.state().cached > 0 &&
            window.__map.state().pending === 0 &&
            window.__map.state().draws > 0,
          undefined,
          { timeout: 30_000 },
        );
        await page.evaluate(() => {
          const map = window.__map,
            state = map.state();
          map.pan(-8.5 - state.cx, -8.5 - state.cz);
          map.zoom(20 / state.scale);
        });
        await page.waitForFunction(
          () =>
            window.__map.state().pending === 0 &&
            !window.__map.state().terrain?.busy,
          undefined,
          { timeout: 20_000 },
        );
        const canvas = page.locator("#map");
        const bounds = await canvas.boundingBox();
        assert.ok(bounds);
        await page.mouse.move(
          bounds.x + bounds.width / 2,
          bounds.y + bounds.height / 2,
        );
        await page
          .locator("#inspect")
          .waitFor({ state: "visible", timeout: 10_000 });
        assert.equal(
          await page.locator("#block-pos").textContent(),
          "-9 / 65 / -9",
        );
        assert.match(await page.locator("#block-name").textContent(), /grass/i);
        const pixels = PNG.sync.read(await canvas.screenshot());
        const center =
          (Math.floor(pixels.height / 2) * pixels.width +
            Math.floor(pixels.width / 2)) *
          4;
        assert.ok(
          pixels.data[center + 1] > pixels.data[center] &&
            pixels.data[center + 1] > pixels.data[center + 2],
          "the known center grass column must render green, not only a background pattern",
        );
        const colors = new Set();
        for (let i = 0; i < pixels.data.length; i += 4 * 101)
          colors.add(
            `${pixels.data[i]},${pixels.data[i + 1]},${pixels.data[i + 2]}`,
          );
        assert.ok(
          colors.size >= 3,
          "generated grass surface must render nonblank colored pixels",
        );
        const state = await page.evaluate(() => window.__map.state());
        assert.equal(state.failures.length, 0);
        assert.equal(Boolean(state.terrain), !suffix.includes("terrain=off"));
        if (suffix.includes("players=off"))
          assert.ok(
            !requests.some((url) => url.endsWith("/players")),
            "player opt-out must not contact its feed",
          );
        if (suffix.includes("terrain=off"))
          assert.ok(
            !requests.some((url) => url.includes("/terrain/")),
            "terrain opt-out must use the seeded snapshot",
          );
        assert.ok(
          requests.every(
            (url) => url.startsWith(`${origin}/`) || url.startsWith("blob:"),
          ),
          "viewer may request only its own origin",
        );
        assert.deepEqual(errors, []);
        cases.push({
          path: suffix,
          picking: "-9 / 65 / -9",
          material: "grass",
          distinct_pixel_colors: colors.size,
          terrain_live_binding: Boolean(state.terrain),
          terrain_draws: state.draws,
        });
      } finally {
        await page.close();
      }
    }
    return {
      ok: true,
      browser: "chromium",
      version: browser.version(),
      browser_host: `${process.platform}-${process.arch}`,
      renderer: "WebGPU/SwiftShader test adapter",
      test_root_spki: spki,
      cases,
    };
  } finally {
    await browser.close();
  }
}
