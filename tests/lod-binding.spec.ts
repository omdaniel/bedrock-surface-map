import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ViewerConfiguration } from "../web/src/config";
import type { LodManifest } from "../web/src/lod/protocol";

const directory = resolve(".local/terrain-fixture");
const root: LodManifest = JSON.parse(
  readFileSync(resolve(directory, "lod-0.json"), "utf8"),
);
const snapshot = "/maps/bound-snapshot";
const api = "/api/v1/worlds/fixture-world/terrain";
const identity = {
  world_id: root.world_id!,
  generation: root.generation,
};
const staticConfiguration: ViewerConfiguration = {
  lod_url: `${snapshot}/lod.json`,
  lod_identity: identity,
};
const terrain = {
  ...identity,
  url: `${api}/manifest.json`,
  lod_url: `${api}/lod.json`,
};

async function serve(page: Page, configuration: ViewerConfiguration) {
  const reads = { snapshot: 0, live: 0 };
  await page.route("**/viewer-config.json", (route) =>
    route.fulfill({ json: configuration }),
  );
  await page.route(
    (url) =>
      url.pathname.startsWith(`${snapshot}/`) ||
      url.pathname.startsWith(`${api}/`),
    (route) => {
      const path = new URL(route.request().url()).pathname;
      const live = path.startsWith(api);
      if (live) reads.live++;
      if (path.endsWith("/lod.json")) {
        if (!live) reads.snapshot++;
        return route.fulfill({ json: root });
      }
      if (path.endsWith("/status"))
        return route.fulfill({
          json: {
            schema_version: 1,
            ...identity,
            status: "live",
            reason: "live",
            lod: {
              status: "live",
              revision_lag: 0,
              pending_age_ms: null,
              last_published_ms: 1000,
              reason: null,
            },
          },
        });
      return route.fulfill({
        body: readFileSync(
          resolve(directory, "state/objects", path.split("/").at(-1)!),
        ),
      });
    },
  );
  return reads;
}

async function ready(page: Page) {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const state = window.__map?.state();
          return Boolean(
            window.__map?.ready &&
            state?.lod?.tiles &&
            state.lod.firstVisible !== null &&
            !state.lod.pending &&
            !state.renderPending &&
            !state.lod.failures.length,
          );
        }),
      { timeout: 30000 },
    )
    .toBe(true);
}

for (const scenario of [
  "native snapshot",
  "terrain opt-out",
  "legacy terrain binding",
])
  test(`${scenario} accepts static identity without live polling`, async ({
    page,
  }) => {
    const configuration = { ...staticConfiguration };
    if (scenario === "terrain opt-out") configuration.terrain = terrain;
    if (scenario === "legacy terrain binding")
      configuration.terrain = { ...identity, url: terrain.url };
    const reads = await serve(page, configuration);
    await page.goto(
      `/?players=off${scenario === "terrain opt-out" ? "&terrain=off" : ""}`,
    );
    await ready(page);
    await page.waitForTimeout(2200);
    expect(reads.snapshot).toBeGreaterThan(0);
    expect(reads.live).toBe(0);
    expect(
      (await page.evaluate(() => window.__map.state())).lod!.live,
    ).toBeNull();
  });

for (const mismatch of ["world", "generation", "URL"])
  test(`static identity rejects a different ${mismatch}`, async ({ page }) => {
    const configuration = {
      ...staticConfiguration,
      lod_identity: {
        world_id: mismatch === "world" ? "other-world" : identity.world_id,
        generation:
          mismatch === "generation" ? "other-generation" : identity.generation,
      },
    };
    const reads = await serve(page, configuration);
    await page.goto(
      `/?players=off${mismatch === "URL" ? `&lod=${snapshot}/other/lod.json` : ""}`,
    );
    await expect(page.locator("#message-text")).toContainText(
      "No explicit live-terrain binding",
    );
    expect(await page.evaluate(() => window.__map.ready)).toBe(false);
    expect(reads.live).toBe(0);
  });

test("explicit production live LOD binding still activates the feed", async ({
  page,
}) => {
  const reads = await serve(page, { ...staticConfiguration, terrain });
  await page.goto("/?players=off");
  await ready(page);
  await expect
    .poll(() => page.evaluate(() => window.__map.state().lod?.live?.state))
    .toBe("live");
  expect(reads.snapshot).toBe(0);
  expect(reads.live).toBeGreaterThan(0);
});
