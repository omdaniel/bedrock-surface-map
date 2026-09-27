import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { LodManifest } from "../web/src/lod/protocol";
import { captureLodFailure } from "./lod-evidence";

const directory = resolve(".local/terrain-fixture");
const initial: LodManifest = JSON.parse(
  readFileSync(resolve(directory, "lod-0.json"), "utf8"),
);
const api = "/api/v1/worlds/fixture-world/terrain";

async function serve(
  page: Page,
  root: () => LodManifest,
  dataDirectory = directory,
  binding = initial,
) {
  await page.route("**/viewer-config.json", (route) =>
    route.fulfill({
      json: {
        terrain: {
          lod_url: `${api}/lod.json`,
          url: `${api}/manifest.json`,
          world_id: binding.world_id,
          generation: binding.generation,
        },
      },
    }),
  );
  await page.route(`**${api}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/lod.json")) return route.fulfill({ json: root() });
    if (path.endsWith("/status"))
      return route.fulfill({
        json: {
          schema_version: 1,
          world_id: binding.world_id,
          generation: binding.generation,
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
        resolve(dataDirectory, "state/objects", path.split("/").at(-1)!),
      ),
    });
  });
}

async function settled(page: Page) {
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
            !state.lod.activeKind &&
            !state.lod.queuedUpload &&
            !state.lod.preparations &&
            !state.lod.gpuPending &&
            !state.lod.retiringBytes &&
            !state.lodRecovering &&
            !state.renderPending &&
            !state.lod.failures.length &&
            !state.lod.memory.entries.some((entry) => entry.id === "job"),
          );
        }),
      { timeout: 60000 },
    )
    .toBe(true);
  const state = await page.evaluate(() => window.__map.state());
  expect(state.lod!.memory.peakBytes).toBeLessThanOrEqual(200000000);
}

test("validated appearance reconstruction retains its revision fence against an older matching root", async ({
  page,
}) => {
  const dataDirectory = resolve(".local/lod-catalog-fixture");
  const beforeRoot: LodManifest = JSON.parse(
    readFileSync(resolve(dataDirectory, "lod-4.json"), "utf8"),
  );
  const next: LodManifest = JSON.parse(
    readFileSync(resolve(dataDirectory, "lod-5.json"), "utf8"),
  );
  expect(next.atlas.sha256).not.toBe(beforeRoot.atlas.sha256);
  let publish = false;
  let served = false;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await serve(
    page,
    () => {
      if (publish && !served) {
        served = true;
        return next;
      }
      return beforeRoot;
    },
    dataDirectory,
    beforeRoot,
  );
  await page.goto("/?players=off");
  await settled(page);
  const before = await page.evaluate(() => window.__map.state());
  publish = true;
  await expect
    .poll(() => page.evaluate(() => window.__map.state().lod?.live?.revision), {
      timeout: 15000,
    })
    .toBe(next.revision);
  await settled(page);
  await expect
    .poll(() => page.evaluate(() => window.__map.state().lod?.live?.error))
    .toContain("revision moved backwards");
  const retained = await page.evaluate(() => window.__map.state());
  expect(retained.lod!.live!.revision).toBe(next.revision);
  expect([
    retained.cx,
    retained.cz,
    retained.scale,
    retained.elevation,
    retained.azimuth,
  ]).toEqual([
    before.cx,
    before.cz,
    before.scale,
    before.elevation,
    before.azimuth,
  ]);
  // Recovery also reconstructs from the accepted epoch when the publisher is stale.
  await page.evaluate(() => window.__map.loseDevice());
  await expect
    .poll(() => page.evaluate(() => window.__map.state().lodRecoveries))
    .toBe(1);
  await settled(page);
  expect(
    (await page.evaluate(() => window.__map.state())).lod!.live!.revision,
  ).toBe(next.revision);
  expect(errors).toEqual([]);
});

for (const failure of ["module", "WASM"])
  test(`initial decoder ${failure} failure recovers through explicit Retry without reload`, async ({
    page,
    context,
  }) => {
    let faults = 0;
    let wasmRequests = 0;
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await serve(page, () => initial);
    await context.route(
      failure === "module"
        ? "**/lod/decoder.worker.ts*"
        : "**/surface_gpu_bg.wasm*",
      (route) => {
        const fail = failure === "module" ? faults === 0 : ++wasmRequests === 2;
        if (fail) {
          faults++;
          return route.fulfill({ status: 503, body: "transient init failure" });
        }
        return route.continue();
      },
    );
    await page.goto("/?players=off");
    await expect.poll(() => faults).toBe(1);
    await expect
      .poll(() =>
        page.evaluate(() => window.__map?.state().lod?.failures.length ?? 0),
      )
      .toBeGreaterThan(0);
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__map
            .state()
            .lod!.memory.entries.some((entry) => entry.id === "job"),
        ),
      )
      .toBe(false);
    await page.evaluate(() => {
      (window as Window & { recoveryMarker?: boolean }).recoveryMarker = true;
    });
    await page
      .locator("#retry")
      .evaluate((button: HTMLButtonElement) => button.click());
    await settled(page);
    expect(
      await page.evaluate(
        () => (window as Window & { recoveryMarker?: boolean }).recoveryMarker,
      ),
    ).toBe(true);
    expect(faults).toBe(1);
    expect(errors).toEqual([]);
    const state = await page.evaluate(() => window.__map.state());
    expect(
      state.lod!.memory.entries.find((entry) => entry.id === "wasm:worker")!
        .totalBytes,
    ).toBe(16 * 1024 * 1024);
  });

test.afterEach(({ page }, info) => captureLodFailure(page, info));
