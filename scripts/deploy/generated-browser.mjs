import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import { connect as tlsConnect } from "node:tls";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PNG } from "pngjs";
import { chromium } from "playwright";

export async function verifyGeneratedBrowser({
  port,
  ca,
  password,
  producer,
  features = { terrain: true, players: true },
  evidenceDirectory,
}) {
  // Validate the live certificate using the disposable CA first. Pin the leaf
  // presented to Chromium: the server does not send its root in the TLS chain.
  const certificate = await new Promise((resolve, reject) => {
    const socket = tlsConnect(
      { host: "127.0.0.1", port, servername: "map.example.test", ca },
      () => {
        resolve(socket.getPeerCertificate().raw);
        socket.end();
      },
    );
    socket.once("error", reject);
    socket.setTimeout(5000, () =>
      socket.destroy(Error("test certificate validation timeout")),
    );
  });
  const leafKey = new X509Certificate(certificate).publicKey.export({
    type: "spki",
    format: "der",
  });
  const spki = createHash("sha256").update(leafKey).digest("base64");
  const origin = `https://map.example.test:${port}`;
  const browser = await chromium.launch({
    headless: process.platform !== "linux",
    args: [
      "--enable-unsafe-webgpu",
      ...(process.platform === "linux"
        ? [
            "--enable-features=Vulkan",
            "--use-angle=vulkan",
            "--use-vulkan=swiftshader",
            "--use-webgpu-adapter=swiftshader",
            "--disable-vulkan-surface",
          ]
        : ["--use-angle=swiftshader"]),
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
        errors = [],
        consoleMessages = [];
      page.on("request", (request) => requests.push(request.url()));
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (["error", "warning"].includes(message.type())) consoleMessages.push(message.text());
      });
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
          `the known center grass column must render green, not only a background pattern: ${[...pixels.data.subarray(center, center + 4)]}`,
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
        assert.equal(
          Boolean(state.terrain),
          features.terrain && !suffix.includes("terrain=off"),
        );
        if (!features.players || suffix.includes("players=off"))
          assert.ok(
            !requests.some((url) => url.endsWith("/players")),
            "player opt-out must not contact its feed",
          );
        if (!features.terrain || suffix.includes("terrain=off"))
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
        let protocol = null;
        if (producer && suffix === "/") {
          await producer.negativeChecks();
          const change = async (height, material, expectedName) => {
            const before = await page.evaluate(
              () => window.__map.state().terrain.revision,
            );
            await producer.terrain(material, height);
            await page.waitForFunction(
              (revision) =>
                !window.__map.state().terrain?.busy &&
                window.__map.state().terrain?.revision > revision,
              before,
              { timeout: 20_000 },
            );
            await page.mouse.move(
              bounds.x + bounds.width / 2 + 1,
              bounds.y + bounds.height / 2,
            );
            await page.waitForFunction(
              ({ height, material }) =>
                document.querySelector("#block-pos")?.textContent ===
                  `-9 / ${height} / -9` &&
                document
                  .querySelector("#block-name")
                  ?.textContent?.toLowerCase()
                  .includes(material),
              { height, material: expectedName },
              { timeout: 20_000 },
            );
          };
          await change(68, "sand", "sand");
          const changed = PNG.sync.read(await canvas.screenshot());
          assert.ok(
            !changed.data.equals(pixels.data),
            "a real terrain message must change rendered pixels",
          );
          const changedDraws = await page.evaluate(
            () => window.__map.state().draws,
          );
          await producer.players(-8.5, 90);
          const marker = page.locator(
            '[data-player-id="fictional-player"].player-marker',
          );
          await marker.waitFor({ state: "visible", timeout: 10_000 });
          await page.waitForFunction(() => {
            const m = document.querySelector(
              '[data-player-id="fictional-player"].player-marker',
            );
            return m?.querySelector("svg")?.style.transform === "rotate(45deg)";
          });
          const markerBefore = await marker.boundingBox();
          assert.ok(markerBefore);
          await producer.players(-6.5, 180);
          await page.waitForFunction(() => {
            const m = document.querySelector(
              '[data-player-id="fictional-player"].player-marker',
            );
            return (
              m?.querySelector("svg")?.style.transform === "rotate(135deg)"
            );
          });
          const markerAfter = await marker.boundingBox();
          assert.ok(markerAfter);
          assert.ok(
            Math.abs(markerAfter.x - markerBefore.x - 40) < 1,
            "two blocks at 20 pixels/block must move the marker 40 pixels east",
          );
          assert.equal(
            await page.evaluate(() => window.__map.state().draws),
            changedDraws,
            "player-only updates must not redraw stationary terrain",
          );
          // A successful HTTP poll must not keep an abandoned sample alive.
          await page.waitForFunction(
            () =>
              document
                .querySelector(".players-status")
                ?.textContent?.startsWith("Stale positions"),
            undefined,
            { timeout: 20_000 },
          );
          await marker.waitFor({ state: "hidden", timeout: 30_000 });
          await producer.players(-6.5, 180);
          await marker.waitFor({ state: "visible", timeout: 10_000 });
          await producer.players(null);
          await marker.waitFor({ state: "detached", timeout: 10_000 });
          await change(65, "grass", "grass");
          assert.ok(!page.isClosed());
          protocol = {
            live_edit: true,
            picking: true,
            changed_pixels: true,
            marker_heading: true,
            marker_projection: true,
            empty_roster: true,
            stale_sample_expiry_and_recovery: true,
            player_only_redraws: 0,
            rejected_writes: true,
          };
        }
        assert.deepEqual(errors, []);
        cases.push({
          path: suffix,
          picking: "-9 / 65 / -9",
          material: "grass",
          distinct_pixel_colors: colors.size,
          terrain_live_binding: Boolean(state.terrain),
          terrain_draws: state.draws,
          protocol,
          adapter: await page.evaluate(async () => {
            const adapter = await navigator.gpu.requestAdapter();
            const info = adapter?.info;
            return info
              ? {
                  vendor: info.vendor,
                  architecture: info.architecture,
                  device: info.device,
                  description: info.description,
                }
              : null;
          }),
        });
      } catch (error) {
        if (evidenceDirectory) {
          await mkdir(evidenceDirectory, { recursive: true });
          await page.screenshot({
            path: join(evidenceDirectory, `case-${cases.length}.png`),
          });
          await writeFile(
            join(evidenceDirectory, `case-${cases.length}.json`),
            JSON.stringify(
              {
                path: suffix,
              errors,
              consoleMessages,
                state: await page.evaluate(() => ({
                  map: window.__map?.state(),
                  message: document.querySelector("#message")?.textContent,
                })),
              },
              null,
              2,
            ),
          );
        }
        throw error;
      } finally {
        await page.close();
      }
    }
    return {
      ok: true,
      browser: "chromium",
      version: browser.version(),
      browser_host: `${process.platform}-${process.arch}`,
      renderer: "WebGPU; adapter information recorded per case",
      verified_test_leaf_spki: spki,
      cases,
    };
  } finally {
    await browser.close();
  }
}
