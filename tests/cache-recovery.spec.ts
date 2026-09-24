import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const directory = resolve(".local/terrain-large");

for (const factor of [4, 16]) {
  test(`${factor}x terrain rejects oversized views without stranding navigation`, async ({
    page,
  }) => {
    const root = JSON.parse(
      readFileSync(resolve(directory, `root-${factor}.json`), "utf8"),
    );
    const errors: string[] = [];
    let objectRequests = 0;
    let sequence = 0;
    const snapshot = JSON.parse(
      readFileSync("fixtures/tracking/snapshot.json", "utf8"),
    );
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      const errors: string[] = [];
      Object.defineProperty(window, "__cacheErrors", { value: errors });
      window.addEventListener("error", (event) => errors.push(event.message));
    });
    await page.route("**/viewer-config.json", (route) =>
      route.fulfill({
        json: {
          players: {
            world_id: root.world_id,
            generation: root.generation,
            source_sha256: root.source_sha256,
            url: `/api/v1/worlds/${root.world_id}/players`,
          },
          terrain: {
            world_id: root.world_id,
            generation: root.generation,
            url: `/api/v1/worlds/${root.world_id}/terrain/manifest.json`,
          },
        },
      }),
    );
    await page.route("**/api/v1/worlds/*/players", (route) =>
      route.fulfill({
        json: {
          schema_version: 1,
          world_id: root.world_id,
          status: "live",
          age_ms: 0,
          reason: null,
          snapshot: {
            ...snapshot,
            sequence: ++sequence,
            sampled_at_ms: Date.now(),
            players: [
              {
                ...snapshot.players[0],
                position: { x: 8, y: 64, z: 8, heading: 90 },
              },
            ],
          },
        },
      }),
    );
    await page.route("**/api/v1/worlds/*/terrain/**", (route) => {
      const name = new URL(route.request().url()).pathname.split("/").at(-1)!;
      if (name === "manifest.json") return route.fulfill({ json: root });
      if (name === "status")
        return route.fulfill({
          json: {
            world_id: root.world_id,
            generation: root.generation,
            status: "live",
            diagnostics: {},
          },
        });
      objectRequests++;
      return route.fulfill({
        body: readFileSync(resolve(directory, "objects", name)),
        contentType: name.endsWith(".png")
          ? "image/png"
          : name.endsWith(".json")
            ? "application/json"
            : "application/octet-stream",
      });
    });
    await page.goto("/");
    await expect
      .poll(() =>
        page.evaluate(() => {
          const state = window.__map?.state();
          return (
            window.__map?.ready &&
            state.cached > 0 &&
            state.pending === 0 &&
            !state.terrain?.busy &&
            state.firstVisible !== null
          );
        }),
      )
      .toBe(true);

    // Exercise detail exhaustion separately from a height window too large to fit.
    for (const targetScale of [0.4, 0.025]) {
      const before = await page.evaluate(() => window.__map.state());
      const requests = objectRequests;
      await page.evaluate((scale) => {
        window.__map.zoom(scale / window.__map.state().scale);
      }, targetScale);
      await expect(page.locator("#message-text")).toContainText("256 MiB");
      const rejected = await page.evaluate(() => window.__map.state());
      expect([rejected.cx, rejected.cz, rejected.scale]).toEqual([
        before.cx,
        before.cz,
        before.scale,
      ]);
      expect(rejected.memory).toBeLessThanOrEqual(256 * 1024 * 1024);
      await page.waitForTimeout(2200);
      expect(objectRequests - requests).toBeLessThan(4);
      const alignment = await page.evaluate(() => {
        const state = window.__map.state();
        const marker = document.querySelector<HTMLElement>(".player-marker")!;
        const viewport = document.querySelector<HTMLElement>("main")!;
        const transform = new DOMMatrixReadOnly(marker.style.transform);
        return {
          actual: [transform.m41, transform.m42],
          expected: [
            viewport.clientWidth / 2 + (8 - state.cx) * state.scale,
            viewport.clientHeight / 2 + (8 - state.cz) * state.scale,
          ],
        };
      });
      expect(alignment.actual[0]).toBeCloseTo(alignment.expected[0], 1);
      expect(alignment.actual[1]).toBeCloseTo(alignment.expected[1], 1);

      await page.getByRole("button", { name: "Zoom in", exact: true }).click();
      await expect
        .poll(() => page.evaluate(() => window.__map.state().draws))
        .toBeGreaterThan(before.draws);
      await expect(page.locator("#message")).toBeHidden();
      expect(
        await page.evaluate(() => window.__map.state().scale),
      ).toBeGreaterThan(before.scale);
    }

    const beforePan = await page.evaluate(() => window.__map.state());
    await page.locator("#map").focus();
    await page.keyboard.press("ArrowRight");
    await expect
      .poll(() => page.evaluate(() => window.__map.state().cx))
      .toBeGreaterThan(beforePan.cx);
    await expect
      .poll(() => page.evaluate(() => window.__map.state().draws))
      .toBeGreaterThan(beforePan.draws);
    await page.evaluate(() =>
      window.__map.zoom(0.8 / window.__map.state().scale),
    );
    await expect
      .poll(() =>
        page.evaluate(() => {
          const state = window.__map.state();
          return !state.terrain?.busy && state.pending === 0;
        }),
      )
      .toBe(true);
    const beforeResize = await page.evaluate(() => window.__map.state());
    await page.setViewportSize({ width: 2560, height: 1440 });
    await expect
      .poll(() => page.evaluate(() => window.__map.state().scale))
      .toBeGreaterThan(beforeResize.scale);
    await expect
      .poll(() => page.evaluate(() => window.__map.state().draws))
      .toBeGreaterThan(beforeResize.draws);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const state = window.__map.state();
          return state.pending === 0 && !state.terrain?.busy;
        }),
      )
      .toBe(true);
    expect(
      await page.evaluate(() => window.__map.state().memory),
    ).toBeLessThanOrEqual(256 * 1024 * 1024);
    expect(errors).toEqual([]);
    expect(
      await page.evaluate(() => Reflect.get(window, "__cacheErrors")),
    ).toEqual([]);
    await page.screenshot({
      path: `test-results/cache-recovery-${factor}x.png`,
    });
  });
}
