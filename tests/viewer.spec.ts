import { test, expect } from "@playwright/test";
import { PNG } from "pngjs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const fixture = "/?map=/maps/fixture/manifest.json";
async function ready(page: import("@playwright/test").Page) {
  await page.waitForFunction(() => window.__map?.ready);
  await page.waitForFunction(() => {
    const s = window.__map.state() as {
      cached: number;
      pending: number;
      firstVisible: number | null;
    };
    return s.cached > 0 && s.pending === 0 && s.firstVisible !== null;
  });
  await expect(page.locator("#message")).toBeHidden();
}
function colors(bytes: Buffer) {
  const png = PNG.sync.read(bytes);
  const unique = new Set();
  for (let y = 100; y < png.height - 100; y += 5)
    for (let x = 100; x < png.width - 100; x += 5) {
      const i = (y * png.width + x) * 4;
      unique.add(png.data.subarray(i, i + 3).toString("hex"));
    }
  return unique;
}
test("synthetic pixels, picking, navigation, idle, toggles, resize and device recovery", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(fixture);
  await ready(page);
  const pixels = colors(await page.screenshot());
  const near = (expected: number[]) =>
    [...pixels].some((v) =>
      expected.every(
        (c, i) =>
          Math.abs(parseInt(String(v).slice(i * 2, i * 2 + 2), 16) - c) <= 2,
      ),
    );
  expect(
    near([90, 160, 64]),
    `Grass pixels absent: ${[...pixels].slice(0, 20)}`,
  ).toBe(true);
  expect(
    near([155, 158, 160]),
    `Stone pixels absent: ${[...pixels].slice(0, 20)}`,
  ).toBe(true);
  expect(
    [...pixels].some((v) => {
      const n = String(v);
      const r = parseInt(n.slice(0, 2), 16),
        g = parseInt(n.slice(2, 4), 16),
        b = parseInt(n.slice(4, 6), 16);
      return b > g && g > r * 1.25;
    }),
  ).toBe(true);
  await page.mouse.move(640, 400);
  await expect(page.locator("#inspect")).toBeVisible();
  await expect(page.locator("#coordinates")).toContainText("-");
  const before = (await page.evaluate(() => window.__map.state())) as {
    cx: number;
    scale: number;
    draws: number;
    memory: number;
  };
  await page.mouse.move(700, 400);
  await page.mouse.down();
  await page.mouse.move(800, 400, { steps: 8 });
  await page.mouse.up();
  expect(
    ((await page.evaluate(() => window.__map.state())) as { cx: number }).cx,
  ).not.toBe(before.cx);
  await page.mouse.wheel(0, -400);
  await expect
    .poll(
      async () =>
        ((await page.evaluate(() => window.__map.state())) as { scale: number })
          .scale,
    )
    .toBeGreaterThan(before.scale);
  await page.getByRole("button", { name: "World spawn", exact: true }).click();
  await page.getByRole("button", { name: "Sun shadows", exact: true }).click();
  await expect(page.locator("#sun")).toHaveAttribute("aria-pressed", "false");
  await page
    .getByRole("button", { name: "Block borders", exact: true })
    .click();
  await page.waitForTimeout(200);
  const draws = (
    (await page.evaluate(() => window.__map.state())) as { draws: number }
  ).draws;
  await page.waitForTimeout(400);
  expect(
    ((await page.evaluate(() => window.__map.state())) as { draws: number })
      .draws,
  ).toBe(draws);
  expect(before.memory).toBeLessThanOrEqual(256 * 1024 * 1024);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Fit world", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await page.screenshot({ path: "test-results/synthetic-mobile.png" });
  await page.evaluate(() => window.__map.loseDevice());
  await expect(page.locator("#message")).toContainText("GPU device lost");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await ready(page);
  expect(errors).toEqual([]);
});
test("download failure and retry", async ({ page }) => {
  await page.route("**/*.bsm.zst", (route) =>
    route.fulfill({ status: 503, body: "unavailable" }),
  );
  await page.goto(fixture);
  await expect(page.locator("#message")).toContainText("HTTP 503");
  await page.unroute("**/*.bsm.zst");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await ready(page);
});
test("corrupt payload is not empty terrain", async ({ page }) => {
  await page.route("**/*.bsm.zst", (route) =>
    route.fulfill({ body: "bad payload" }),
  );
  await page.goto(fixture);
  await expect(page.locator("#message")).toContainText("checksum mismatch");
});
test("missing WebGPU is explicit", async ({ page }) => {
  await page.addInitScript(() => {
    delete (Navigator.prototype as unknown as { gpu?: unknown }).gpu;
  });
  await page.goto(fixture);
  await expect(page.locator("#message")).toContainText("WebGPU is unavailable");
});
test("development server refuses raw world paths", async ({ request }) => {
  const dir = await mkdtemp(join(tmpdir(), "surface-private-"));
  try {
    const path = join(dir, "synthetic.mcworld");
    await writeFile(path, "synthetic private data, never serve", {
      mode: 0o600,
    });
    const response = await request.get(`/@fs${path}`);
    expect([403, 404]).toContain(response.status());
    expect(await response.text()).not.toContain(
      "synthetic private data, never serve",
    );
  } finally {
    await rm(dir, { recursive: true });
  }
});
test("invalid manifest bounds fail before allocating terrain", async ({
  page,
}) => {
  await page.route(
    (url) => url.pathname === "/maps/fixture/manifest.json",
    async (route) => {
      const response = await route.fetch();
      const m = await response.json();
      m.bounds = [0, 0, 99999999, 99999999];
      await route.fulfill({ json: m });
    },
  );
  await page.goto(fixture);
  await expect(page.locator("#message")).toContainText(
    "Unsupported or empty map manifest",
  );
});
