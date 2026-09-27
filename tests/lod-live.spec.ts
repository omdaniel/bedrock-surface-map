import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { LodManifest, LodNode, NodeRef } from "../web/src/lod/protocol";
import { captureLodFailure } from "./lod-evidence";

const directory = resolve(".local/terrain-fixture");
const object = (url: string) => readFileSync(resolve(directory, "state", url));
const roots: LodManifest[] = [0, 1, 2, 3].map((i) =>
  JSON.parse(readFileSync(resolve(directory, `lod-${i}.json`), "utf8")),
);
function leaf(root: LodManifest, x: number, z: number): LodNode {
  let refs: NodeRef[] = root.roots;
  for (;;) {
    const ref = refs.find(
      ({ key }) =>
        Math.floor(x / (128 * 2 ** key.level)) === key.x &&
        Math.floor(z / (128 * 2 ** key.level)) === key.z,
    )!;
    const node: LodNode = JSON.parse(object(ref.index.url).toString());
    if (!node.key.level) return node;
    refs = node.children;
  }
}
async function settled(page: Page) {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const state = window.__map?.state();
          return Boolean(
            window.__map?.ready &&
            state?.lod?.firstVisible !== null &&
            state?.lod?.tiles &&
            !state.lod.pending &&
            !state.renderPending &&
            !state.lod.failures.length,
          );
        }),
      { timeout: 60000 },
    )
    .toBe(true);
}

test("live LOD replaces resident chunks, preserves camera and players, and resumes after an outage", async ({
  page,
}) => {
  test.setTimeout(180000);
  let step = 0,
    outage = false,
    x = -120.5,
    sequence = 0,
    publicationLag = 0,
    publicationAge = 0;
  const requests: string[] = [];
  const errors: string[] = [];
  const player = JSON.parse(
    readFileSync("fixtures/tracking/snapshot.json", "utf8"),
  );
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/viewer-config.json", (route) =>
    route.fulfill({
      json: {
        terrain: {
          lod_url: "/api/v1/worlds/fixture-world/terrain/lod.json",
          world_id: "fixture-world",
          generation: "fixture-generation",
          url: "/api/v1/worlds/fixture-world/terrain/manifest.json",
        },
        players: {
          world_id: "fixture-world",
          generation: "fixture-generation",
          source_sha256: roots[0].source_sha256,
          url: "/api/v1/worlds/fixture-world/players",
        },
      },
    }),
  );
  await page.route("**/api/v1/worlds/fixture-world/players", (route) => {
    const snapshot = structuredClone(player);
    snapshot.sequence = ++sequence;
    snapshot.sampled_at_ms = Date.now();
    snapshot.players[0].position = { x, y: 16, z: -120.5, heading: 90 };
    return route.fulfill({
      json: {
        schema_version: 1,
        world_id: "fixture-world",
        status: "live",
        reason: null,
        age_ms: 0,
        snapshot,
      },
    });
  });
  await page.route("**/api/v1/worlds/fixture-world/terrain/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    requests.push(path);
    if (outage) return route.fulfill({ status: 503 });
    if (path.endsWith("/status"))
      return route.fulfill({
        json: {
          schema_version: 1,
          world_id: "fixture-world",
          generation: "fixture-generation",
          status: "live",
          reason: "live",
          sample_age_ms: 0,
          last_repair_ms: 1000,
          lod: {
            status: publicationLag
              ? publicationAge > 30000
                ? "degraded"
                : "updating"
              : "live",
            revision: roots[step].revision,
            source_revision: roots[step].revision + publicationLag,
            published_source_revision: roots[step].revision,
            revision_lag: publicationLag,
            pending_age_ms: publicationAge || null,
            last_published_ms: 1000,
            reason: null,
          },
        },
      });
    if (path.endsWith("lod.json")) {
      const etag = `"lod-${step}"`;
      return route.request().headers()["if-none-match"] === etag
        ? route.fulfill({ status: 304, headers: { ETag: etag } })
        : route.fulfill({ json: roots[step], headers: { ETag: etag } });
    }
    return route.fulfill({
      body: object(`objects/${path.split("/").at(-1)}`),
      contentType: path.endsWith(".json")
        ? "application/json"
        : path.endsWith(".png")
          ? "image/png"
          : "application/octet-stream",
    });
  });
  await page.goto("/");
  await settled(page);
  await page.getByRole("button", { name: "Players", exact: true }).click();
  await expect(page.locator(".players-status")).toHaveText("1 online");
  await page
    .getByRole("button", { name: "Center on ExamplePlayer", exact: true })
    .click();
  await page.evaluate(() => window.__map.zoom(6 / window.__map.state().scale));
  await settled(page);
  const before = await page.evaluate(() => window.__map.state());
  expect(before.lod!.level).toBe(0);
  const count = requests.length;
  step = 1;
  await expect
    .poll(() => page.evaluate(() => window.__map.state().lod?.live?.revision), {
      timeout: 15000,
    })
    .toBe(roots[1].revision);
  await settled(page);
  const box = (await page.locator("#map").boundingBox())!;
  // Inspect exposed terrain beside the marker, not the marker's DOM hit target.
  await page.mouse.move(
    box.x + box.width / 2 + 24,
    box.y + box.height / 2 + 24,
  );
  await expect(page.locator("#block-name")).toHaveText("sand");
  await expect(page.locator("#block-pos")).toContainText("/ 16.00 /");
  const updated = leaf(roots[1], x, -120.5);
  expect(
    requests.slice(count).some((path) => path.endsWith(updated.data.url)),
  ).toBe(false);
  expect(
    requests
      .slice(count)
      .some((path) =>
        path.endsWith(
          updated.chunks!.find((chunk) => chunk.cx === -8 && chunk.cz === -8)!
            .url,
        ),
      ),
  ).toBe(true);
  const after = await page.evaluate(() => window.__map.state());
  expect([
    after.cx,
    after.cz,
    after.scale,
    after.azimuth,
    after.elevation,
  ]).toEqual([
    before.cx,
    before.cz,
    before.scale,
    before.azimuth,
    before.elevation,
  ]);
  const draws = after.draws;
  x = -119.5;
  await expect(page.locator(".player-detail")).toContainText("-120,");
  await page.waitForTimeout(4200);
  expect(await page.evaluate(() => window.__map.state().draws)).toBe(draws);
  publicationLag = 1;
  publicationAge = 1000;
  await expect(page.locator(".local-state")).toHaveText("Terrain updating", {
    timeout: 10000,
  });
  publicationAge = 31001;
  await expect(page.locator(".local-state")).toHaveText("Terrain degraded", {
    timeout: 10000,
  });
  expect(await page.evaluate(() => window.__map.state().draws)).toBe(draws);
  publicationLag = publicationAge = 0;
  await expect(page.locator(".local-state")).toHaveText("Terrain live", {
    timeout: 10000,
  });
  outage = true;
  await expect(page.locator(".local-state")).toHaveText("Terrain delayed", {
    timeout: 15000,
  });
  expect(
    await page.evaluate(() => window.__map.state().lod!.tiles),
  ).toBeGreaterThan(0);
  step = 2;
  outage = false;
  await expect
    .poll(() => page.evaluate(() => window.__map.state().lod?.live?.revision), {
      timeout: 30000,
    })
    .toBe(roots[2].revision);
  await page.evaluate(() => {
    const state = window.__map.state();
    window.__map.pan(1032 - state.cx, 8 - state.cz);
  });
  await settled(page);
  await page.mouse.move(box.x + box.width / 2 + 2, box.y + box.height / 2 + 2);
  await expect(page.locator("#block-pos")).toContainText("/ 5.00 /");
  expect(
    (await page.evaluate(() => window.__map.state())).lod!.memory.peakBytes,
  ).toBeLessThanOrEqual(200000000);
  expect(errors).toEqual([]);
  await page.screenshot({ path: "test-results/lod-live.png" });
});

test("terrain opt-out uses snapshot LOD without contacting the live terrain service", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.route("**/viewer-config.json", (route) =>
    route.fulfill({
      json: {
        lod_url: "/snapshot/lod.json",
        terrain: {
          lod_url: "/api/v1/worlds/fixture-world/terrain/lod.json",
          url: "/api/v1/worlds/fixture-world/terrain/manifest.json",
          world_id: "fixture-world",
          generation: "fixture-generation",
        },
      },
    }),
  );
  await page.route("**/snapshot/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/lod.json")) {
      const root = structuredClone(roots[0]);
      delete root.world_id;
      return route.fulfill({ json: root });
    }
    return route.fulfill({ body: object(`objects/${path.split("/").at(-1)}`) });
  });
  await page.goto("/?terrain=off&players=off");
  await settled(page);
  expect(requests.some((url) => url.endsWith("/snapshot/lod.json"))).toBe(true);
  expect(requests.some((url) => url.includes("/terrain/"))).toBe(false);
  expect(await page.evaluate(() => window.__map.state().lod?.live)).toBeNull();
});

test("live LOD rejects unrelated or older roots without replacing valid terrain", async ({
  page,
}) => {
  test.setTimeout(120000);
  let current = structuredClone(roots[1]);
  let accepted = roots[1];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/viewer-config.json", (route) =>
    route.fulfill({
      json: {
        terrain: {
          lod_url: "/api/v1/worlds/fixture-world/terrain/lod.json",
          world_id: "fixture-world",
          generation: "fixture-generation",
          url: "/api/v1/worlds/fixture-world/terrain/manifest.json",
        },
      },
    }),
  );
  await page.route("**/api/v1/worlds/fixture-world/terrain/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("lod.json")) return route.fulfill({ json: current });
    if (path.endsWith("/status"))
      return route.fulfill({
        json: {
          schema_version: 1,
          world_id: accepted.world_id,
          generation: accepted.generation,
          status: "live",
          reason: "live",
          sample_age_ms: 0,
          last_repair_ms: 1000,
          lod: {
            status: "live",
            revision: accepted.revision,
            source_revision: accepted.revision,
            published_source_revision: accepted.revision,
            revision_lag: 0,
            pending_age_ms: null,
            last_published_ms: 1000,
            reason: null,
          },
        },
      });
    return route.fulfill({
      body: object(`objects/${path.split("/").at(-1)}`),
    });
  });
  await page.goto("/?players=off");
  await settled(page);
  await expect(page.locator(".local-state")).toHaveText("Terrain live");
  const baseline = await page.evaluate(() => window.__map.state());
  const pixels = await page.locator("canvas").screenshot();
  for (const [change, reason] of [
    [{ world_id: "unrelated-world" }, "world binding changed"],
    [{ generation: "unrelated-generation" }, "generation changed"],
    [{ revision: roots[0].revision }, "revision moved backwards"],
  ] as const) {
    current = { ...structuredClone(roots[1]), ...change };
    await expect
      .poll(() => page.evaluate(() => window.__map.state().lod?.live?.error))
      .toContain(reason);
    const retained = await page.evaluate(() => window.__map.state());
    expect(retained.lod?.live?.revision).toBe(roots[1].revision);
    expect(retained.draws).toBe(baseline.draws);
    expect([retained.cx, retained.cz, retained.scale]).toEqual([
      baseline.cx,
      baseline.cz,
      baseline.scale,
    ]);
    expect(await page.locator("canvas").screenshot()).toEqual(pixels);
    current = structuredClone(roots[1]);
    await expect(page.locator(".local-state")).toHaveText("Terrain live", {
      timeout: 15000,
    });
  }
  accepted = roots[2];
  current = structuredClone(accepted);
  await expect
    .poll(() => page.evaluate(() => window.__map.state().lod?.live?.revision), {
      timeout: 15000,
    })
    .toBe(accepted.revision);
  await settled(page);
  const recovered = await page.evaluate(() => window.__map.state());
  expect([recovered.cx, recovered.cz, recovered.scale]).toEqual([
    baseline.cx,
    baseline.cz,
    baseline.scale,
  ]);
  expect(recovered.lod!.memory.peakBytes).toBeLessThanOrEqual(200000000);
  expect(errors).toEqual([]);
});

test.afterEach(({ page }, info) => captureLodFailure(page, info));
