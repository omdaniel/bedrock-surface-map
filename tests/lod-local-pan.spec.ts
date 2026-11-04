import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ObjectRef } from "../web/src/types";
import type { LodManifest, LodNode, NodeRef } from "../web/src/lod/protocol";

// Uses preconverted synthetic fixtures and the existing Playwright/Vite launch.
// After the bulk source integration and WASM build are ready:
// npx --no-install playwright test tests/lod-local-pan.spec.ts
// SURFACE_LOD_LOCAL_FIXTURE=/path/to/converted-synthetic-8k enables long pans
// at every level. The default 1024 fixture has no stride-8 level. Never convert
// automatically here, or substitute private world/player data in test artifacts.
const directory = resolve(
  process.env.SURFACE_LOD_LOCAL_FIXTURE ?? ".local/lod-browser",
);
const prefix = "/lod-local";
const viewport = { width: 640, height: 480 };
type LocalSync = {
  status: "syncing" | "ready" | "error";
  objects: number;
  bytes: number;
  revision: number;
  error: string;
  persistent: boolean;
};

function fixture(dir: string, name = "lod.json") {
  const root: LodManifest = JSON.parse(
    readFileSync(resolve(dir, name), "utf8"),
  );
  const objects = new Map<string, ObjectRef>();
  const nodes = new Map<string, LodNode>();
  const add = (ref: ObjectRef) => {
    if (!/^objects\/[a-f0-9]{64}\.[a-z0-9]+$/.test(ref.url))
      throw Error(`Fixture has a noncanonical object path: ${ref.url}`);
    objects.set(ref.sha256, ref);
  };
  const visit = (ref: NodeRef) => {
    if (objects.has(ref.index.sha256)) return;
    add(ref.index);
    const node: LodNode = JSON.parse(
      readFileSync(resolve(dir, ref.index.url), "utf8"),
    );
    nodes.set(`${node.key.level}/${node.key.x}/${node.key.z}`, node);
    add(node.data);
    add(node.height);
    node.children.forEach(visit);
  };
  add(root.atlas);
  root.catalog.forEach(add);
  root.roots.forEach(visit);
  // Inventory the complete rendering graph, including invisible leaves and all
  // summaries/heights. Legacy ingestion chunk references are not renderer input.
  return {
    dir,
    root,
    objects,
    nodes,
    bytes: [...objects.values()].reduce((sum, ref) => sum + ref.bytes, 0),
    maxLevel: Math.max(...root.roots.map((r) => r.key.level)),
  };
}
type Fixture = ReturnType<typeof fixture>;
// The 8K fixture has 16K small immutable objects. Cold IndexedDB transactions
// and individually intercepted HTTP requests take longer than renderer settling.
const syncTimeout = (data: Fixture) =>
  data.objects.size > 2048 ? 10 * 60 * 1000 : 90000;

async function mount(
  page: Page,
  current: () => Fixture,
  players?: Record<string, unknown>,
) {
  const requests: string[] = [];
  const errors: string[] = [];
  let blocked = false;
  page.on("pageerror", (error) => errors.push(error.message));
  // Keep the modules loaded by this page stable during development-server
  // acceptance runs; explicit reload still tests persistence.
  // Only Vite's development updates are filtered, never application messages.
  await page.routeWebSocket("**", (client) => {
    const server = client.connectToServer();
    if (client.protocols().includes("vite-hmr"))
      server.onMessage((message) => {
        if (typeof message === "string") {
          const payload = JSON.parse(message);
          if (["full-reload", "update"].includes(payload.type)) return;
        }
        client.send(message);
      });
  });
  await page.route("**/viewer-config.json", (route) =>
    route.fulfill({ json: { lod_url: `${prefix}/lod.json`, players } }),
  );
  await page.route(`**${prefix}/**`, (route) => {
    const path = new URL(route.request().url()).pathname.slice(
      prefix.length + 1,
    );
    if (path === "lod.json")
      return route.fulfill({
        json: current().root,
        headers: { "Cache-Control": "no-store" },
      });
    if (!/^objects\/[a-f0-9]{64}\.[a-z0-9]+$/.test(path))
      return route.fulfill({ status: 404 });
    requests.push(path);
    if (blocked) return route.abort("internetdisconnected");
    return route.fulfill({
      body: readFileSync(resolve(current().dir, path)),
      // Route interception and no-store prevent the HTTP cache from masking a
      // missing persisted object. Mutable-root polling remains available.
      headers: { "Cache-Control": "no-store" },
      contentType: path.endsWith(".json")
        ? "application/json"
        : path.endsWith(".png")
          ? "image/png"
          : "application/octet-stream",
    });
  });
  await page.goto(players ? "/" : "/?players=off");
  await page.waitForFunction(() => window.__map?.ready);
  return {
    requests,
    errors,
    block() {
      blocked = true;
      requests.length = 0;
    },
  };
}

async function localReady(page: Page, data: Fixture) {
  const started = Date.now();
  let reported = started;
  await expect
    .poll(
      async () => {
        const value = await page.evaluate(() => {
          const s = window.__map.state();
          const local = (s.lod as { local?: LocalSync } | null)?.local;
          return { current: s.lod?.revision, ...local };
        });
        if (data.objects.size > 2048 && Date.now() - reported >= 30000) {
          reported = Date.now();
          console.info(
            JSON.stringify({
              phase: "local-sync",
              seconds: (reported - started) / 1000,
              ...value,
            }),
          );
        }
        return value;
      },
      { timeout: syncTimeout(data) },
    )
    .toMatchObject({
      current: data.root.revision,
      revision: data.root.revision,
      status: "ready",
      error: "",
    });
  const local = await page.evaluate(
    () => (window.__map.state().lod as unknown as { local: LocalSync }).local,
  );
  expect(local.objects).toBeGreaterThanOrEqual(data.objects.size);
  expect(local.bytes).toBeGreaterThanOrEqual(data.bytes);
  expect(typeof local.persistent).toBe("boolean");
}

async function settle(page: Page, level?: number) {
  await page.waitForFunction(
    (target) => {
      const s = window.__map?.state();
      return (
        s?.lod &&
        !s.lod.pending &&
        !s.lod.queued &&
        !s.renderPending &&
        s.lod.cut.length > 0 &&
        (target === undefined || s.lod.level === target) &&
        s.lod.cut.every((tile) => tile.key.level <= s.lod!.level)
      );
    },
    level,
    { timeout: 60000 },
  );
  const state = await page.evaluate(() => window.__map.state());
  expect(state.lod!.error).toBe("");
  expect(state.lod!.failures).toEqual([]);
  expect(state.lod!.memory + state.lod!.reserve).toBeLessThanOrEqual(
    256 * 1024 * 1024,
  );
  return state;
}

async function aim(page: Page, x: number, z: number, scale: number) {
  await page.evaluate(
    ({ x, z, scale }) => {
      const s = window.__map.state();
      window.__map.pan(x - s.cx, z - s.cz);
      window.__map.zoom(scale / s.scale);
    },
    { x, z, scale },
  );
}

test.use({ viewport, serviceWorkers: "block" });

test("the complete local world survives distant pans, zoom reversals and reload with immutable routes blocked", async ({
  page,
}) => {
  const data = fixture(directory);
  test.setTimeout(syncTimeout(data) + 120000);
  const wire = await mount(page, () => data);
  await localReady(page, data);
  const fetched = new Set(wire.requests);
  for (const ref of data.objects.values())
    expect(fetched.has(ref.url)).toBe(true);
  const [left, top, right, bottom] = data.root.bounds;
  const near = [left + 128, top + 128];
  const far = [right - 128, bottom - 128];
  expect(far[0] - near[0]).toBeGreaterThan(viewport.width / 8 + 2 * 128);
  await aim(page, near[0], near[1], 8);
  const before = await settle(page, 0);
  wire.block();
  await aim(page, far[0], far[1], 8);
  const distant = await settle(page, 0);
  expect(distant.lod!.totalDecode).toBeGreaterThan(before.lod!.totalDecode);
  expect(
    distant.lod!.cut.some(
      (t) =>
        !before.lod!.cut.some(
          (old) => JSON.stringify(old.key) === JSON.stringify(t.key),
        ),
    ),
  ).toBe(true);
  const levels = [0, 1, 2, 3, 2, 1, 0].filter((n) => n <= data.maxLevel);
  if (data.maxLevel < 3)
    test.info().annotations.push({
      type: "coverage",
      description:
        "Default fixture covers full/2/4; stride 8 requires SURFACE_LOD_LOCAL_FIXTURE with level >=3.",
    });
  for (const level of levels) {
    // 1.6 physical pixels/sample selects the same level from either direction
    // of the existing 1..3-pixel hysteresis (test device scale factor is one).
    await aim(page, far[0], far[1], 1.6 / 2 ** level);
    await settle(page, level);
  }
  expect(wire.requests).toEqual([]);
  await page.reload();
  await page.waitForFunction(() => window.__map?.ready);
  await localReady(page, data);
  await aim(page, near[0], near[1], 8);
  await settle(page, 0);
  await aim(page, far[0], far[1], 8);
  await settle(page, 0);
  expect(wire.requests).toEqual([]);
  expect(wire.errors).toEqual([]);
});

test("slow 60Hz pans at every available stride keep the target cut ready after one local fill", async ({
  page,
}) => {
  const data = fixture(directory);
  test.setTimeout(syncTimeout(data) + 4 * 120000);
  const wire = await mount(page, () => data);
  await localReady(page, data);
  // One cold fill and one context for the entire pan workload. Every following
  // zoom, initial guard-band settle and measured pan must read only local bytes.
  wire.block();
  for (const level of [0, 1, 2, 3]) {
    const stride = 2 ** level;
    const scale = 1.6 / stride;
    const [left, top, right, bottom] = data.root.bounds;
    const width = viewport.width / scale;
    const height = viewport.height / scale;
    const travel = 256 * stride;
    if (
      data.maxLevel < level ||
      right - left < width + travel + 256 * stride ||
      bottom - top < height
    ) {
      test.info().annotations.push({
        type: "coverage",
        description: `Stride ${stride} pan not measured: use SURFACE_LOD_LOCAL_FIXTURE with a larger preconverted synthetic map (8K supports all four levels).`,
      });
      continue;
    }
    await test.step(`stride ${stride}`, async () => {
      const start = left + width / 2 + 128 * stride;
      await aim(page, start, (top + bottom) / 2, scale);
      await settle(page, level);
      // Exclude initial decode/upload/zoom settling. Motion is then continuous:
      // do not wait for each new tile or allow network recovery between samples.
      const measured = await page.evaluate(
        async ({ travel, level }) => {
          const initial = window.__map.state();
          const samples: {
            at: number;
            hit: boolean;
            fallback: boolean;
            blank: boolean;
          }[] = [];
          const frames = 480;
          let last = performance.now();
          for (let frame = 0; frame < frames; frame++) {
            window.__map.pan(travel / frames, 0);
            await new Promise<void>((done) => {
              const tick = (now: number) => {
                if (now - last < 1000 / 60 - 1) requestAnimationFrame(tick);
                else {
                  last = now;
                  done();
                }
              };
              requestAnimationFrame(tick);
            });
            const s = window.__map.state();
            samples.push({
              at: last,
              hit: s.lod!.lastPanHit,
              fallback: s.lod!.cut.some((tile) => tile.key.level > level),
              blank: s.lod!.cut.length === 0,
            });
          }
          const final = window.__map.state();
          return {
            samples,
            dx: final.cx - initial.cx,
            fallbackFrames:
              final.lod!.framesWithFallback - initial.lod!.framesWithFallback,
            decoded: final.lod!.totalDecode - initial.lod!.totalDecode,
          };
        },
        { travel, level },
      );
      const gaps = measured.samples
        .slice(1)
        .map((sample, i) => sample.at - measured.samples[i].at)
        .sort((a, b) => a - b);
      const report = {
        level,
        stride,
        frames: measured.samples.length,
        misses: measured.samples.filter((s) => !s.hit).length,
        fallbacks: measured.samples.filter((s) => s.fallback).length,
        blanks: measured.samples.filter((s) => s.blank).length,
        p95FrameMs: gaps[Math.floor(gaps.length * 0.95)],
        immutableRequests: [...wire.requests],
        pageErrors: [...wire.errors],
        ...measured,
      };
      await test.info().attach(`local-pan-stride-${stride}.json`, {
        body: Buffer.from(JSON.stringify(report)),
        contentType: "application/json",
      });
      console.info(
        JSON.stringify({
          phase: "pan",
          stride,
          frames: report.frames,
          misses: report.misses,
          fallbacks: report.fallbacks,
          blanks: report.blanks,
          fallbackFrames: report.fallbackFrames,
          p95FrameMs: report.p95FrameMs,
          decoded: report.decoded,
          immutableRequests: wire.requests.length,
          pageErrors: wire.errors,
        }),
      );
      expect.soft(measured.dx).toBeCloseTo(travel, 5);
      expect.soft(report.misses).toBe(0);
      expect.soft(report.fallbacks).toBe(0);
      expect.soft(report.blanks).toBe(0);
      expect.soft(report.fallbackFrames).toBe(0);
      expect.soft(report.decoded).toBeGreaterThan(0);
      // Detect an overloaded host rather than silently calling a slow replay 60Hz.
      // The one-frame margin tolerates occasional browser/driver scheduling jitter.
      expect.soft(report.p95FrameMs).toBeLessThan(1000 / 30 + 2);
      await settle(page, level);
      expect.soft(wire.requests).toEqual([]);
      expect.soft(wire.errors).toEqual([]);
    });
  }
});

test("a changed root synchronizes offscreen edited leaves before the camera visits them", async ({
  page,
}) => {
  test.setTimeout(180000);
  const live = resolve(".local/lod-live");
  const stages = [0, 1, 2].map((n) => fixture(live, `stage${n}.json`));
  let current = stages[0];
  const wire = await mount(page, () => current);
  await aim(page, -192, 384, 8);
  await localReady(page, current);
  await settle(page, 0);
  const camera = await page.evaluate(() => window.__map.state());
  // The entire edited chunk (0..16, 0..16) is outside this viewport.
  expect(camera.cx + viewport.width / (2 * camera.scale)).toBeLessThan(0);
  expect(camera.cz - viewport.height / (2 * camera.scale)).toBeGreaterThan(16);
  for (let stage = 1; stage < stages.length; stage++) {
    const before = current;
    const requestsBefore = wire.requests.length;
    current = stages[stage];
    const changed = current.nodes.get("0/0/0")!;
    expect(changed.data.sha256).not.toBe(
      before.nodes.get("0/0/0")!.data.sha256,
    );
    await localReady(page, current);
    const fetched = new Set(wire.requests.slice(requestsBefore));
    expect(fetched.has(changed.data.url)).toBe(true);
    expect(fetched.has(changed.height.url)).toBe(true);
    for (const [hash, ref] of current.objects)
      if (!before.objects.has(hash)) expect(fetched.has(ref.url)).toBe(true);
    expect(await page.evaluate(() => window.__map.state())).toMatchObject({
      cx: camera.cx,
      cz: camera.cz,
      scale: camera.scale,
    });
  }
  wire.block();
  await aim(page, 8, 8, 8);
  await settle(page, 0);
  const box = (await page.locator("#map").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator("#block-pos")).toContainText("/ 128.0 /");
  expect(wire.requests).toEqual([]);
  expect(wire.errors).toEqual([]);
});

test("player-only updates leave a fully synchronized stationary LOD view undrawn", async ({
  page,
}) => {
  test.setTimeout(120000);
  const data = fixture(resolve(".local/lod-live"), "stage0.json");
  const world = data.root.world_id!;
  const url = `/api/v1/worlds/${world}/players`;
  const template = JSON.parse(
    readFileSync("fixtures/tracking/snapshot.json", "utf8"),
  );
  let polls = 0;
  await page.route(`**${url}`, (route) => {
    const snapshot = structuredClone(template);
    snapshot.world_id = world;
    snapshot.sequence = ++polls;
    snapshot.sampled_at_ms = Date.now();
    snapshot.players[0].position = {
      x: -64 + polls / 10,
      y: 64,
      z: 256,
      heading: 90,
    };
    return route.fulfill({
      json: {
        schema_version: 1,
        world_id: world,
        status: "live",
        reason: null,
        age_ms: 0,
        snapshot,
      },
    });
  });
  const wire = await mount(page, () => data, {
    world_id: world,
    generation: data.root.generation,
    source_sha256: data.root.source_sha256,
    url,
    poll_interval_ms: 100,
  });
  await localReady(page, data);
  await expect(page.locator(".player-marker")).toHaveCount(1);
  await page.evaluate(() => document.fonts.ready);
  const before = await settle(page);
  const oldPolls = polls;
  const marker = await page.locator(".player-marker").getAttribute("style");
  wire.block();
  await expect
    .poll(() => polls, { timeout: 5000 })
    .toBeGreaterThanOrEqual(oldPolls + 12);
  await expect(page.locator(".player-marker")).not.toHaveAttribute(
    "style",
    marker!,
  );
  expect((await page.evaluate(() => window.__map.state())).draws).toBe(
    before.draws,
  );
  expect(wire.requests).toEqual([]);
  expect(wire.errors).toEqual([]);
  // Existing tests/players.spec.ts legacy redraw/polling assertions stay intact.
});
