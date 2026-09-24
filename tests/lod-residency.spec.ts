import { test, expect, type Page, type Route } from "@playwright/test";
import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import {
  parseManifest,
  parseNode,
  tileBounds,
  tileId,
} from "../web/src/lod/protocol.ts";

const DIRECTORY = "web/public/maps/lod-fixture/";
const FIXTURE = "/maps/lod-fixture/lod.json";
const VIEWER = `/?lod=${FIXTURE}&players=off`;
const manifest = parseManifest(
  JSON.parse(readFileSync(`${DIRECTORY}lod.json`, "utf8")),
  new URL("http://127.0.0.1/maps/lod-fixture/"),
);
const maxLevel = manifest.roots[0].key.level;
const maxIndexes = manifest.roots.reduce(
  (sum, root) => sum + (4 ** (root.key.level + 1) - 1) / 3,
  0,
);
const catalogIds = new Set(
  manifest.catalog.map((page) => `catalog:${page.start}`),
);
const west = { x: manifest.bounds[0] + 64, z: manifest.bounds[1] + 64 };
const east = { x: manifest.bounds[2] - 64, z: manifest.bounds[3] - 64 };
type State = ReturnType<Window["__map"]["state"]>;

const state = (page: Page) => page.evaluate(() => window.__map.state());
const camera = (value: State) => ({
  cx: value.cx,
  cz: value.cz,
  scale: value.scale,
  elevation: value.elevation,
  azimuth: value.azimuth,
});

function bounded(value: State) {
  const lod = value.lod!;
  expect(lod.failures).toEqual([]);
  expect(lod.memory.limitBytes).toBe(200_000_000);
  expect(value.memory).toBeLessThanOrEqual(200_000_000);
  expect(lod.memory.peakBytes).toBeLessThanOrEqual(200_000_000);
  expect(lod.memory.totalBytes).toBeLessThanOrEqual(200_000_000);
  expect(lod.memory.freeBytes).toBeGreaterThanOrEqual(0);
  expect(lod.memory.totalBytes).toBe(
    lod.memory.entries.reduce((sum, entry) => sum + entry.totalBytes, 0),
  );
  expect(
    Object.values(lod.memory.categories).reduce((sum, bytes) => sum + bytes, 0),
  ).toBe(lod.memory.totalBytes);
  for (const [category, bytes] of Object.entries(lod.memory.categories)) {
    expect(bytes, `${category} charge must match its entries`).toBe(
      lod.memory.entries
        .filter((entry) => entry.category === category)
        .reduce((sum, entry) => sum + entry.totalBytes, 0),
    );
  }
  expect(lod.memory.capacityBytes + lod.memory.reservedBytes).toBe(
    lod.memory.totalBytes,
  );
  expect(lod.logicalOccupancy.surfaceBytes).toBeGreaterThanOrEqual(0);
  expect(lod.logicalOccupancy.surfaceBytes).toBeLessThanOrEqual(
    lod.memory.categories.surface,
  );
  expect(lod.logicalOccupancy.pickingBytes).toBe(lod.tiles * 131072);
  expect(lod.logicalOccupancy.pickingBytes).toBe(
    lod.memory.entries
      .filter((entry) => entry.id.startsWith("pick:"))
      .reduce((sum, entry) => sum + entry.capacityBytes, 0),
  );
  expect(lod.logicalOccupancy.heightSlots).toBe(lod.heights);
  expect(lod.logicalOccupancy.heightSlots).toBeLessThanOrEqual(
    lod.logicalOccupancy.heightSlotCapacity,
  );
  expect(new Set(lod.memory.entries.map((entry) => entry.id)).size).toBe(
    lod.memory.entries.length,
  );
  const indexes = lod.memory.entries.filter((entry) =>
    entry.id.startsWith("index:"),
  );
  const catalogs = lod.memory.entries.filter((entry) =>
    entry.id.startsWith("catalog:"),
  );
  expect(indexes.length).toBe(lod.indexes);
  expect(lod.indexes).toBeLessThanOrEqual(Math.min(512, maxIndexes));
  expect(catalogs.length).toBeLessThanOrEqual(catalogIds.size);
  expect(lod.catalogPages).toBe(catalogs.length);
  expect(lod.materialDescriptors).toBe(
    manifest.catalog
      .filter((page) =>
        catalogs.some((entry) => entry.id === `catalog:${page.start}`),
      )
      .reduce((sum, page) => sum + page.count, 0),
  );
  for (const entry of catalogs) {
    expect(catalogIds.has(entry.id)).toBe(true);
    expect(entry.category).toBe("cpu");
    expect(entry.capacityBytes).toBeGreaterThan(0);
  }
}

async function settled(page: Page, level: number) {
  await page.waitForFunction(
    (level) => {
      const value = window.__map?.state(),
        lod = value?.lod;
      return Boolean(
        window.__map?.ready &&
        lod &&
        lod.firstVisible !== null &&
        lod.level === level &&
        lod.targetLevel === level &&
        value.pending === 0 &&
        lod.pending === 0 &&
        lod.activeKind === null &&
        !lod.queuedUpload &&
        lod.preparations === 0 &&
        lod.gpuPending === 0 &&
        lod.retiringBytes === 0 &&
        !value.renderPending &&
        !lod.memory.entries.some(
          (entry) => entry.id === "job" || entry.id === "catalog-job",
        ),
      );
    },
    level,
    { timeout: 60_000 },
  );
  const value = await state(page);
  bounded(value);
  return value;
}

async function aim(page: Page, position: { x: number; z: number }, scale = 6) {
  await page.evaluate(
    ({ position, scale }) => {
      const before = window.__map.state();
      window.__map.pan(position.x - before.cx, position.z - before.cz);
      window.__map.zoom(scale / window.__map.state().scale);
    },
    { position, scale },
  );
  const value = await state(page);
  expect(value.cx).toBeCloseTo(position.x);
  expect(value.cz).toBeCloseTo(position.z);
  expect(value.scale).toBeCloseTo(scale);
}

async function openCoarse(page: Page, players = false) {
  await page.goto(players ? `/?lod=${FIXTURE}` : VIEWER);
  await page.waitForFunction(() => window.__map?.ready);
  await page.evaluate(() =>
    window.__map.zoom(0.12 / window.__map.state().scale),
  );
  return settled(page, maxLevel);
}

async function quiet(page: Page, before: State) {
  // A fixed observation window detects a continuing render loop, not just an idle instant.
  await page.waitForTimeout(750);
  const after = await state(page);
  bounded(after);
  expect(after.draws).toBe(before.draws);
  expect(after.renderPending).toBe(false);
  expect(after.lod!.preparations).toBe(0);
  expect(after.lod!.retiringBytes).toBe(0);
  expect(after.lod!.pending).toBe(0);
  expect(after.lod!.queuedUpload).toBe(false);
  expect(after.lod!.cut).toEqual(before.lod!.cut);
  expect(camera(after)).toEqual(camera(before));
  return after;
}

function footprint(value: State) {
  const lod = value.lod!;
  return {
    indexes: lod.indexes,
    tiles: lod.tiles,
    heights: lod.heights,
    metadata: lod.memory.entries
      .filter((entry) => /^(index|catalog):/.test(entry.id))
      .map(({ id, totalBytes }) => ({ id, totalBytes }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

function westDetail() {
  const contains = ({ key }: (typeof manifest.roots)[number]) => {
    const box = tileBounds(key);
    return (
      west.x >= box[0] && west.x < box[2] && west.z >= box[1] && west.z < box[3]
    );
  };
  let ref = manifest.roots.find(contains);
  for (let depth = 0; ref && depth <= maxLevel; depth++) {
    const node = parseNode(
      JSON.parse(readFileSync(`${DIRECTORY}${ref.index.url}`, "utf8")),
      ref.key,
      new URL("http://127.0.0.1/maps/lod-fixture/"),
    );
    if (node.key.level === 0) return { ref: node.data, id: tileId(node.key) };
    ref = node.children.find(contains);
  }
  throw Error("Synthetic fixture lacks the west detail leaf");
}

async function holdFirstDetail(page: Page) {
  const detail = westDetail();
  const url = new URL(
    detail.ref.url,
    new URL("/maps/lod-fixture/", page.url()),
  );
  let hits = 0,
    release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = new Set<Promise<void>>();
  const handler = (route: Route) => {
    const operation = (async () => {
      hits++;
      if (hits === 1) await gate;
      // A genuine abort can close the first request before its delayed response is released.
      await route.continue().catch((error: unknown) => {
        if (!/closed|cancel|abort|Invalid InterceptionId/i.test(String(error)))
          throw error;
      });
    })();
    pending.add(operation);
    return operation.finally(() => pending.delete(operation));
  };
  await page.context().route(url.href, handler);
  return {
    id: detail.id,
    hits: () => hits,
    release,
    async close() {
      release();
      // Unrouting an in-flight handler can also continue it; finish our continuation first.
      while (pending.size) await Promise.all(pending);
      await page.context().unroute(url.href, handler);
    },
  };
}

test.describe("LOD bounded residency over repeated navigation", () => {
  test.setTimeout(180_000);
  test.afterEach(async ({ page }, info) => {
    if (info.status !== info.expectedStatus && !page.isClosed()) {
      const value = await page
        .evaluate(() => window.__map?.state())
        .catch(() => null);
      await info.attach("lod-residency-state", {
        body: Buffer.from(JSON.stringify(value, null, 2)),
        contentType: "application/json",
      });
    }
  });

  test("repeated lighting and zoom reversals drain retirement and stop terrain frames", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openCoarse(page);
    await page
      .getByRole("button", { name: "Lighting and color", exact: true })
      .click();
    let prior: ReturnType<typeof footprint> | undefined;
    for (let cycle = 0; cycle < 3; cycle++) {
      for (const elevation of [15, 75]) {
        await page
          .getByRole("slider", { name: "Sun elevation", exact: true })
          .evaluate((element: HTMLInputElement, elevation) => {
            element.value = String(elevation);
            element.dispatchEvent(new Event("input", { bubbles: true }));
          }, elevation);
        const dial = page.getByRole("slider", {
          name: "Sun azimuth",
          exact: true,
        });
        await dial.press(elevation === 15 ? "Home" : "End");
        const azimuth = elevation === 15 ? 0 : 359;
        await aim(page, { x: 64, z: 64 });
        const fine = await settled(page, 0);
        expect(fine.lod!.catalogPages).toBeGreaterThan(0);
        expect(camera(fine)).toEqual({
          cx: 64,
          cz: 64,
          scale: 6,
          elevation,
          azimuth,
        });
        await quiet(page, fine);
        await aim(page, { x: 64, z: 64 }, 0.12);
        const coarse = await settled(page, maxLevel);
        expect(coarse.lod!.tiles).toBeLessThan(fine.lod!.tiles);
        expect(coarse.lod!.catalogPages).toBe(0);
        expect(coarse.lod!.materialDescriptors).toBe(0);
        expect(camera(coarse)).toEqual({
          cx: 64,
          cz: 64,
          scale: expect.closeTo(0.12, 8),
          elevation,
          azimuth,
        });
        await quiet(page, coarse);
      }
      const current = footprint(await state(page));
      if (prior) expect(current).toEqual(prior);
      prior = current;
    }
    expect(errors).toEqual([]);
  });

  test("far pans and repeated revisits keep metadata, catalog and residency bounded", async ({
    page,
  }) => {
    await openCoarse(page);
    const sun = camera(await state(page));
    const positions = [
      west,
      east,
      { x: west.x, z: east.z },
      { x: east.x, z: west.z },
      { x: 8192, z: -8192 },
      { x: -8192, z: 8192 },
      { x: 64, z: 64 },
    ];
    let prior: ReturnType<typeof footprint> | undefined;
    let priorBytes: number | undefined;
    for (let cycle = 0; cycle < 3; cycle++) {
      for (const position of positions) {
        await aim(page, position);
        const value = await settled(page, 0);
        expect(camera(value)).toEqual({
          cx: position.x,
          cz: position.z,
          scale: 6,
          elevation: sun.elevation,
          azimuth: sun.azimuth,
        });
        if (Math.abs(position.x) > 512) expect(value.lod!.cut).toEqual([]);
      }
      const end = await quiet(page, await state(page));
      expect(
        end.lod!.memory.entries.some((entry) =>
          entry.id.startsWith("catalog:"),
        ),
      ).toBe(true);
      if (prior) {
        expect(footprint(end)).toEqual(prior);
        expect(end.lod!.memory.totalBytes).toBeLessThanOrEqual(priorBytes!);
      }
      prior = footprint(end);
      priorBytes = end.lod!.memory.totalBytes;
    }
  });

  for (const transition of [
    "rapid camera reversal",
    "native hidden-tab resume",
  ] as const) {
    test(`obsolete same-level detail cannot reappear after ${transition}`, async ({
      page,
    }, info) => {
      const before = await openCoarse(page);
      const gate = await holdFirstDetail(page);
      let covering: Page | undefined;
      try {
        await page.bringToFront();
        await aim(page, west);
        await expect.poll(gate.hits, { timeout: 30_000 }).toBe(1);
        const loading = await state(page);
        expect(
          loading.lod!.memory.entries.find((entry) => entry.id === "job")
            ?.reservationBytes,
        ).toBeGreaterThan(0);
        if (transition === "native hidden-tab resume") {
          covering = await page.context().newPage();
          await covering.bringToFront();
          const hidden = await page
            .waitForFunction(() => document.hidden, undefined, {
              timeout: 3000,
            })
            .then(
              () => true,
              () => false,
            );
          info.annotations.push({
            type: "visibility",
            description:
              "Actual native tab activation only; no visibility property overrides or synthetic events. OS lock/suspend and display sleep are not simulated.",
          });
          test.skip(
            !hidden,
            "Native tab activation did not actually hide the map in this browser configuration",
          );
          await expect
            .poll(
              () => page.evaluate(() => window.__map.state().lod!.pending),
              { timeout: 5000 },
            )
            .toBe(0);
          await aim(page, east);
          const hiddenState = await state(page);
          expect(
            hiddenState.lod!.memory.entries.some((entry) => entry.id === "job"),
          ).toBe(false);
          expect(
            hiddenState.lod!.memory.entries.some(
              (entry) => entry.id === `pick:${gate.id}`,
            ),
          ).toBe(false);
          gate.release();
          await page.bringToFront();
          await page.waitForFunction(() => !document.hidden);
        } else {
          await page.evaluate(
            async (positions) => {
              for (const position of positions) {
                const value = window.__map.state();
                window.__map.pan(position.x - value.cx, position.z - value.cz);
                await new Promise(requestAnimationFrame);
              }
            },
            [east, west, east],
          );
          await expect
            .poll(
              () =>
                page.evaluate(() => window.__map.state().lod!.cancellations),
              { timeout: 5000 },
            )
            .toBeGreaterThan(before.lod!.cancellations);
        }
        const latest = await settled(page, 0);
        expect(camera(latest)).toEqual({
          cx: east.x,
          cz: east.z,
          scale: 6,
          elevation: before.elevation,
          azimuth: before.azimuth,
        });
        expect(latest.lod!.cut.length).toBeGreaterThan(0);
        expect(latest.lod!.cut).not.toContain(gate.id);
        expect(
          latest.lod!.memory.entries.some(
            (entry) => entry.id === `pick:${gate.id}`,
          ),
        ).toBe(false);
        gate.release();
        await quiet(page, latest);
        // A new visit may legitimately request that leaf again after the obsolete job died.
        await aim(page, west);
        const revisited = await settled(page, 0);
        expect(revisited.lod!.cut).toContain(gate.id);
        expect(gate.hits()).toBeGreaterThanOrEqual(2);
        await quiet(page, revisited);
      } finally {
        await gate.close();
        await covering?.close();
        if (!page.isClosed()) await page.bringToFront();
      }
    });
  }

  test("device loss recovers once automatically, then preserves the view through explicit Retry", async ({
    page,
  }, info) => {
    const errors: string[] = [],
      expectedLossErrors: string[] = [];
    let inducedLosses = 0;
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const text = message.text();
      // Suppress only the renderer's diagnostic for each deliberately destroyed device.
      if (
        /^(?:Error: )?LOD GPU device lost:/.test(text) &&
        expectedLossErrors.length < inducedLosses
      )
        expectedLossErrors.push(text);
      else errors.push(text);
    });
    const settings = (value: State) => ({
      ...camera(value),
      shadowStrength: value.shadowStrength,
      vivid: value.vivid,
      reliefStrength: value.reliefStrength,
      reliefWidth: value.reliefWidth,
    });
    const nonblank = async (name: string) => {
      const body = await page.locator("#map").screenshot();
      const png = PNG.sync.read(body),
        colors = new Set<string>();
      for (let y = 0; y < png.height; y += 11)
        for (let x = 0; x < png.width; x += 11) {
          const i = (y * png.width + x) * 4;
          colors.add(
            `${png.data[i] >> 3},${png.data[i + 1] >> 3},${png.data[i + 2] >> 3}`,
          );
        }
      await info.attach(name, { body, contentType: "image/png" });
      expect(
        colors.size,
        "Recovered terrain must not be a blank canvas",
      ).toBeGreaterThan(20);
    };
    await openCoarse(page);
    await aim(page, { x: 128, z: -96 });
    await page
      .getByRole("button", { name: "Lighting and color", exact: true })
      .click();
    for (const [name, value] of [
      ["Sun elevation", 25],
      ["Shadow strength", 35],
      ["Terrain relief", 60],
      ["Edge width", 40],
    ] as const) {
      await page
        .getByRole("slider", { name, exact: true })
        .evaluate((element: HTMLInputElement, value) => {
          element.value = String(value);
          element.dispatchEvent(new Event("input", { bubbles: true }));
        }, value);
    }
    const dial = page.getByRole("slider", { name: "Sun azimuth", exact: true });
    await dial.press("Home");
    await dial.press("PageDown");
    await page
      .getByLabel("Color treatment", { exact: true })
      .selectOption("original");
    await page
      .getByRole("button", { name: "Lighting and color", exact: true })
      .click();
    const before = await settled(page, 0);
    expect(before.lodRecoveries).toBe(0);
    const preserved = settings(before);
    expect(preserved).toMatchObject({
      cx: 128,
      cz: -96,
      scale: 6,
      elevation: 25,
      azimuth: 345,
      vivid: false,
    });
    await nonblank("before-device-loss");

    inducedLosses++;
    await page.evaluate(() => window.__map.loseDevice());
    await page.waitForFunction(
      () => {
        const value = window.__map.state();
        return (
          window.__map.ready &&
          !value.lodRecovering &&
          value.lodRecoveries === 1
        );
      },
      undefined,
      { timeout: 60_000 },
    );
    const automatic = await settled(page, 0);
    expect(settings(automatic)).toEqual(preserved);
    await nonblank("automatic-device-recovery");
    await quiet(page, automatic);

    inducedLosses++;
    await page.evaluate(() => window.__map.loseDevice());
    await page.waitForFunction(
      () => {
        const value = window.__map.state();
        return (
          !window.__map.ready && !value.lodRecovering && value.lod === null
        );
      },
      undefined,
      { timeout: 10_000 },
    );
    const retry = page.getByRole("button", { name: "Retry", exact: true });
    await expect(retry).toBeVisible();
    await expect(page.locator("#message")).toContainText(
      "GPU device lost again",
    );
    const stopped = await state(page);
    expect(stopped.lodRecoveries).toBe(1);
    expect(settings(stopped)).toEqual(preserved);
    await page.waitForTimeout(1500);
    const waiting = await state(page);
    expect(await page.evaluate(() => window.__map.ready)).toBe(false);
    expect(waiting.lodRecovering).toBe(false);
    expect(waiting.lodRecoveries).toBe(1);
    expect(waiting.lod).toBeNull();
    expect(waiting.draws).toBe(stopped.draws);
    expect(waiting.memory).toBeLessThanOrEqual(200_000_000);
    expect(settings(waiting)).toEqual(preserved);
    await expect(retry).toBeVisible();

    await retry.click();
    await page.waitForFunction(
      () => {
        const value = window.__map.state();
        return (
          window.__map.ready &&
          !value.lodRecovering &&
          value.lodRecoveries === 2
        );
      },
      undefined,
      { timeout: 60_000 },
    );
    const manual = await settled(page, 0);
    expect(settings(manual)).toEqual(preserved);
    await expect(retry).toBeHidden();
    await nonblank("manual-device-recovery");
    await quiet(page, manual);
    await info.attach("expected-device-loss-diagnostics", {
      body: Buffer.from(JSON.stringify(expectedLossErrors, null, 2)),
      contentType: "application/json",
    });
    expect(errors).toEqual([]);
  });

  test("moving player-only overlays do not restart settled LOD terrain draws", async ({
    page,
  }) => {
    const template = JSON.parse(
      readFileSync("fixtures/tracking/snapshot.json", "utf8"),
    );
    let calls = 0;
    await page.route("**/viewer-config.json", (route) =>
      route.fulfill({
        json: {
          players: {
            world_id: "fixture-world",
            source_sha256: manifest.source_sha256,
            url: "/api/v1/worlds/fixture-world/players",
            poll_interval_ms: 100,
          },
        },
      }),
    );
    await page.route("**/api/v1/worlds/fixture-world/players", (route) => {
      const snapshot = structuredClone(template);
      snapshot.sequence = ++calls;
      snapshot.sampled_at_ms = Date.now();
      snapshot.players[0].position = {
        x: 64 + 15 * Math.sin(calls / 4),
        z: 64 + 10 * Math.cos(calls / 4),
        y: 64,
        heading: 90,
      };
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
    await openCoarse(page, true);
    await aim(page, { x: 64, z: 64 });
    await page.getByRole("button", { name: "Players", exact: true }).click();
    await expect(page.locator(".player-marker:not([hidden])")).toHaveCount(1);
    const before = await settled(page, 0);
    const marker = page.locator(".player-marker");
    const transform = await marker.evaluate(
      (element: HTMLElement) => element.style.transform,
    );
    const started = calls;
    await expect
      .poll(() => calls, { timeout: 5000 })
      .toBeGreaterThanOrEqual(started + 6);
    await expect
      .poll(() =>
        marker.evaluate((element: HTMLElement) => element.style.transform),
      )
      .not.toBe(transform);
    const after = await quiet(page, before);
    expect(footprint(after)).toEqual(footprint(before));
    expect(after.lod!.tileUploads).toBe(before.lod!.tileUploads);
    await expect(page.locator(".player-follow")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });
});
