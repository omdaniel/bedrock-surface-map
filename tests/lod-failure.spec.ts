import {
  test,
  expect,
  type Page,
  type Route,
  type TestInfo,
} from "@playwright/test";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { PNG } from "pngjs";
import {
  parseManifest,
  parseNode,
  tileBounds,
  type NodeRef,
} from "../web/src/lod/protocol.ts";
import type { ObjectRef } from "../web/src/types.ts";
import { captureLodFailure } from "./lod-evidence";

test.afterEach(({ page }, info) => captureLodFailure(page, info));

const FIXTURE = "/maps/lod-fixture/lod.json";
const VIEWER = `/?lod=${FIXTURE}&players=off`;

function loopbackOrigin(baseURL: string | undefined): string {
  if (!baseURL)
    throw Error("LOD failure tests require the configured loopback baseURL");
  const url = new URL(baseURL);
  const local =
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    (isIP(url.hostname) === 4 && url.hostname.startsWith("127."));
  if (
    !local ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw Error("LOD failure tests only target synthetic fixtures on loopback");
  return url.origin;
}

async function referencedBytes(page: Page, ref: ObjectRef, base: URL) {
  const url = new URL(ref.url, base);
  expect(url.origin).toBe(base.origin);
  const response = await page.request.get(url.href, {
    maxRedirects: 0,
    timeout: 15_000,
  });
  expect(response.status()).toBe(200);
  const body = await response.body();
  expect(body.length).toBe(ref.bytes);
  expect(createHash("sha256").update(body).digest("hex")).toBe(ref.sha256);
  return body;
}

async function detailAtSpawn(page: Page, baseURL: string | undefined) {
  const origin = loopbackOrigin(baseURL);
  const manifestURL = new URL(FIXTURE, origin),
    base = new URL(".", manifestURL);
  const response = await page.request.get(manifestURL.href, {
    maxRedirects: 0,
    timeout: 15_000,
  });
  expect(
    response.status(),
    "Build the native LOD fixture before running this spec",
  ).toBe(200);
  const bytes = await response.body();
  expect(bytes.length).toBeLessThanOrEqual(2 * 1024 * 1024);
  const manifest = parseManifest(JSON.parse(bytes.toString("utf8")), base);
  const anchor = { x: manifest.spawn[0], z: manifest.spawn[2] };
  const contains = ({ key }: NodeRef) => {
    const box = tileBounds(key);
    return (
      anchor.x >= box[0] &&
      anchor.x < box[2] &&
      anchor.z >= box[1] &&
      anchor.z < box[3]
    );
  };
  let current = manifest.roots.find(contains);
  for (let depth = 0; depth <= 16; depth++) {
    if (!current)
      throw Error("Synthetic fixture has no detail node covering spawn");
    const data = await referencedBytes(page, current.index, base);
    const node = parseNode(
      JSON.parse(data.toString("utf8")),
      current.key,
      base,
    );
    if (node.key.level === 0)
      return {
        base,
        manifest,
        anchor,
        ref: node.data,
        url: new URL(node.data.url, base).href,
      };
    current = node.children.find(contains);
  }
  throw Error("Synthetic fixture exceeds the L16 hierarchy");
}

async function visibleDetails(
  page: Page,
  detail: Awaited<ReturnType<typeof detailAtSpawn>>,
) {
  const state = await page.evaluate(() => window.__map.state());
  const canvas = (await page.locator("#map").boundingBox())!;
  const view = [
    state.cx - canvas.width / 6 / 2,
    state.cz - canvas.height / 6 / 2,
    state.cx + canvas.width / 6 / 2,
    state.cz + canvas.height / 6 / 2,
  ];
  const leaves: { url: string; anchor: { x: number; z: number } }[] = [];
  const visit = async (ref: NodeRef) => {
    const box = tileBounds(ref.key);
    const intersection = [
      Math.max(box[0], view[0]),
      Math.max(box[1], view[1]),
      Math.min(box[2], view[2]),
      Math.min(box[3], view[3]),
    ];
    if (
      intersection[0] >= intersection[2] ||
      intersection[1] >= intersection[3]
    )
      return;
    const bytes = await referencedBytes(page, ref.index, detail.base);
    const node = parseNode(
      JSON.parse(bytes.toString("utf8")),
      ref.key,
      detail.base,
    );
    if (node.key.level === 0) {
      leaves.push({
        url: new URL(node.data.url, detail.base).href,
        anchor: {
          x: (intersection[0] + intersection[2]) / 2,
          z: (intersection[1] + intersection[3]) / 2,
        },
      });
      expect(leaves.length).toBeLessThanOrEqual(64);
      return;
    }
    for (const child of node.children) await visit(child);
  };
  for (const root of detail.manifest.roots) await visit(root);
  expect(leaves.length).toBeGreaterThan(0);
  return leaves;
}

async function ready(page: Page) {
  await expect
    .poll(
      () =>
        page
          .evaluate(() => {
            const state = window.__map?.state();
            return Boolean(
              window.__map?.ready &&
              state?.lod &&
              state.lod.tiles > 0 &&
              state.lod.pending === 0 &&
              state.lod.firstVisible !== null &&
              !state.renderPending,
            );
          })
          .catch((error: unknown) => {
            if (String(error).includes("Execution context was destroyed"))
              return false;
            throw error;
          }),
      { timeout: 60_000 },
    )
    .toBe(true);
}

async function openCoarse(page: Page, baseURL: string | undefined) {
  const detail = await detailAtSpawn(page, baseURL);
  await page.goto(new URL(VIEWER, loopbackOrigin(baseURL)).href);
  await ready(page);
  await page.evaluate(({ x, z }) => {
    const state = window.__map.state();
    window.__map.pan(x - state.cx, z - state.cz);
    window.__map.zoom(0.12 / window.__map.state().scale);
  }, detail.anchor);
  await ready(page);
  expect(
    (await page.evaluate(() => window.__map.state())).lod!.level,
  ).toBeGreaterThan(0);
  return detail;
}

async function fine(page: Page) {
  await page.evaluate(() => window.__map.zoom(6 / window.__map.state().scale));
}

function coveringLevel(cut: string[], anchor: { x: number; z: number }) {
  for (const id of cut) {
    const [level, x, z] = id.split("/").map(Number);
    const box = tileBounds({ level, x, z });
    if (
      anchor.x >= box[0] &&
      anchor.x < box[2] &&
      anchor.z >= box[1] &&
      anchor.z < box[3]
    )
      return level;
  }
  return -1;
}

async function recovered(page: Page, anchor: { x: number; z: number }) {
  await expect
    .poll(
      async () =>
        coveringLevel(
          (await page.evaluate(() => window.__map.state())).lod!.cut,
          anchor,
        ),
      {
        timeout: 60_000,
      },
    )
    .toBe(0);
  await ready(page);
  const state = await page.evaluate(() => window.__map.state());
  expect(state.lod!.failures).toEqual([]);
  expect(state.lod!.memory.entries.some((entry) => entry.id === "job")).toBe(
    false,
  );
  expect(state.lod!.memory.peakBytes).toBeLessThanOrEqual(
    state.lod!.memory.limitBytes,
  );
}

async function responsiveCoarse(page: Page, anchor: { x: number; z: number }) {
  const before = await page.evaluate(() => window.__map.state());
  await page.evaluate(() => window.__map.pan(8, -5));
  const input = await page.evaluate(() => window.__map.state());
  expect(input.cx).toBeCloseTo(before.cx + 8);
  expect(input.cz).toBeCloseTo(before.cz - 5);
  expect(input.scale).toBeCloseTo(6);
  await expect
    .poll(() => page.evaluate(() => window.__map.state().draws), {
      timeout:
        process.env.CI || process.env.SURFACE_CI_LOCAL_SOFTWARE === "1"
          ? 15_000
          : 3000,
    })
    .toBeGreaterThan(before.draws);
  const state = await page.evaluate(() => window.__map.state());
  expect(state.cx).toBeCloseTo(before.cx + 8);
  expect(state.cz).toBeCloseTo(before.cz - 5);
  expect(state.scale).toBeCloseTo(6);
  expect(coveringLevel(state.lod!.cut, anchor)).toBeGreaterThan(0);
  expect(state.lod!.cut.length).toBeGreaterThan(0);
  expect(state.lod!.memory.totalBytes).toBeLessThanOrEqual(
    state.lod!.memory.limitBytes,
  );
  expect(state.lod!.memory.peakBytes).toBeLessThanOrEqual(
    state.lod!.memory.limitBytes,
  );
  expect(state.lod!.memory.limitBytes).toBeLessThanOrEqual(200_000_000);
  return state;
}

async function attachCanvas(page: Page, info: TestInfo, name: string) {
  const canvas = page.locator("#map");
  await expect(canvas).toBeVisible();
  const clip = await canvas.boundingBox();
  expect(clip).not.toBeNull();
  const viewport = page.viewportSize()!;
  expect(clip!.x).toBeGreaterThanOrEqual(0);
  expect(clip!.y).toBeGreaterThanOrEqual(0);
  expect(clip!.width).toBeGreaterThan(0);
  expect(clip!.height).toBeGreaterThan(0);
  expect(clip!.x + clip!.width).toBeLessThanOrEqual(viewport.width);
  expect(clip!.y + clip!.height).toBeLessThanOrEqual(viewport.height);
  // Capture the current terrain frame without a separate two-rAF element-stability wait.
  // Camera responsiveness has its own deadline above; software-GPU capture is not that metric.
  const body = await page.screenshot({ clip: clip!, timeout: 15_000 });
  expect(await canvas.boundingBox()).toEqual(clip);
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
    "Available coarse terrain must remain rendered",
  ).toBeGreaterThan(20);
}

async function delayedPayload(page: Page, urls: string | string[]) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let hits = 0;
  let firstURL: string | undefined;
  const targets = new Set(typeof urls === "string" ? [urls] : urls);
  const matches = (value: URL) => targets.has(value.href);
  const handler = async (route: Route) => {
    hits++;
    firstURL ??= route.request().url();
    await gate;
    // The decoder may have canceled this request while the route was held.
    await route.continue().catch(() => {});
  };
  await page.context().route(matches, handler);
  return {
    hits: () => hits,
    firstURL: () => firstURL,
    release,
    async close() {
      release();
      await page.context().unroute(matches, handler);
    },
  };
}

test.describe("LOD failures with real synthetic payload references", () => {
  test.setTimeout(150_000);

  test("a delayed detail payload retains coarse coverage and responsive camera controls", async ({
    page,
    baseURL,
  }, info) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const detail = await openCoarse(page, baseURL);
    const visible = await visibleDetails(page, detail);
    // Block the first visible detail regardless of traversal order. Otherwise an
    // unrelated exact draw can consume a software GPU's request-wait deadline.
    const gate = await delayedPayload(
      page,
      visible.map((tile) => tile.url),
    );
    try {
      await fine(page);
      await expect.poll(gate.hits, { timeout: 30_000 }).toBeGreaterThan(0);
      const fault = visible.find((tile) => tile.url === gate.firstURL())!;
      const state = await responsiveCoarse(page, fault.anchor);
      expect(state.lod!.cut.every((id) => !id.startsWith("0/"))).toBe(true);
      expect(state.lod!.pending).toBe(1);
      expect(
        state.lod!.memory.entries.find((entry) => entry.id === "job")
          ?.reservationBytes,
      ).toBeGreaterThan(0);
      await attachCanvas(page, info, "slow-payload-coarse-coverage");
      gate.release();
      await recovered(page, fault.anchor);
      expect(errors).toEqual([]);
    } finally {
      await info.attach("delayed-detail-state", {
        body: Buffer.from(
          JSON.stringify({
            faultURL: gate.firstURL(),
            visible,
            gateHits: gate.hits(),
            state: await page.evaluate(() => window.__map.state()),
            errors,
          }),
        ),
        contentType: "application/json",
      });
      await gate.close();
    }
  });

  for (const failure of ["503", "corrupt"] as const) {
    test(`${failure} detail payload preserves coarse coverage and recovers after the fault clears`, async ({
      page,
      baseURL,
    }, info) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const detail = await openCoarse(page, baseURL);
      const corrupt =
        failure === "corrupt"
          ? Buffer.from(await referencedBytes(page, detail.ref, detail.base))
          : null;
      if (corrupt) corrupt[Math.floor(corrupt.length / 2)] ^= 0xff;
      let hits = 0,
        active = true;
      const matches = (url: URL) => url.href === detail.url;
      const handler = async (route: Route) => {
        if (!active) {
          await route.continue();
          return;
        }
        hits++;
        await route.fulfill(
          failure === "503"
            ? {
                status: 503,
                contentType: "text/plain",
                body: "Synthetic LOD outage",
              }
            : {
                status: 200,
                contentType: "application/octet-stream",
                body: corrupt!,
              },
        );
      };
      await page.context().route(matches, handler);
      try {
        await fine(page);
        await expect.poll(() => hits, { timeout: 30_000 }).toBeGreaterThan(0);
        const reason = failure === "503" ? "503" : "checksum";
        await expect
          .poll(
            () =>
              page.evaluate(
                (text) =>
                  window.__map
                    .state()
                    .lod!.failures.some((entry) => entry.includes(text)),
                reason,
              ),
            { timeout: 15_000 },
          )
          .toBe(true);
        await responsiveCoarse(page, detail.anchor);
        // Exercise the longer second backoff, not only the first retry.
        await expect.poll(() => hits, { timeout: 15_000 }).toBeGreaterThan(1);
        await attachCanvas(page, info, `${failure}-coarse-coverage`);
        active = false;
        await recovered(page, detail.anchor);
        expect(errors).toEqual([]);
      } finally {
        active = false;
        await page.context().unroute(matches, handler);
      }
    });
  }

  test("returning to coarse cancels an obsolete detail request and releases its reservation after acknowledgement", async ({
    page,
    baseURL,
  }, info) => {
    const detail = await openCoarse(page, baseURL);
    const before = await page.evaluate(() => window.__map.state());
    const gate = await delayedPayload(page, detail.url);
    try {
      await fine(page);
      await expect.poll(gate.hits, { timeout: 30_000 }).toBeGreaterThan(0);
      await page.evaluate(() => {
        window.__map.zoom(0.12 / window.__map.state().scale);
        window.__map.pan(80, 0);
      });
      await expect
        .poll(
          () => page.evaluate(() => window.__map.state().lod!.cancellations),
          { timeout: 5000 },
        )
        .toBeGreaterThan(before.lod!.cancellations);
      await page.evaluate(() => window.__map.pan(-80, 0));
      await expect
        .poll(() => page.evaluate(() => window.__map.state().lod!.pending), {
          timeout: 5000,
        })
        .toBe(0);
      gate.release();
      await ready(page);
      const canceled = await page.evaluate(() => window.__map.state());
      expect(canceled.cx).toBeCloseTo(before.cx);
      expect(canceled.cz).toBeCloseTo(before.cz);
      expect(canceled.scale).toBeCloseTo(0.12);
      expect(canceled.lod!.level).toBeGreaterThan(0);
      expect(
        canceled.lod!.memory.entries.some((entry) => entry.id === "job"),
      ).toBe(false);
      expect(canceled.lod!.memory.peakBytes).toBeLessThanOrEqual(
        canceled.lod!.memory.limitBytes,
      );
      await attachCanvas(page, info, "canceled-detail-coarse-coverage");
      await fine(page);
      await recovered(page, detail.anchor);
    } finally {
      await gate.close();
    }
  });

  test("a real hidden-tab transition cancels work and resumes after native tab activation", async ({
    page,
    baseURL,
    browserName,
  }, info) => {
    test.skip(
      browserName !== "chromium",
      "Native tab visibility coverage is authored for Chrome only",
    );
    info.annotations.push({
      type: "physical-checks",
      description:
        "OS lock/suspend, display sleep, physical refresh-rate changes and GPU resets are not simulated by this test.",
    });
    const detail = await openCoarse(page, baseURL);
    const gate = await delayedPayload(page, detail.url);
    let covering: Page | undefined;
    try {
      await page.bringToFront();
      await fine(page);
      await expect.poll(gate.hits, { timeout: 30_000 }).toBeGreaterThan(0);
      covering = await page.context().newPage();
      await covering.goto("about:blank");
      await covering.bringToFront();
      const hidden = await page
        .waitForFunction(() => document.hidden, undefined, { timeout: 3000 })
        .then(
          () => true,
          () => false,
        );
      await info.attach("visibility-method", {
        body: Buffer.from(
          JSON.stringify(
            {
              method:
                "Real tab activation; document.visibilityState is observed, never overridden",
              hiddenObserved: hidden,
              unavailablePhysicalChecks: [
                "display sleep",
                "OS lock/suspend",
                "physical refresh-rate selection",
                "GPU reset",
              ],
            },
            null,
            2,
          ),
        ),
        contentType: "application/json",
      });
      test.skip(
        !hidden,
        "This browser configuration does not produce a real hidden state on tab activation; repeat in headful Chrome. No visibility getter or event was faked.",
      );
      await expect
        .poll(() => page.evaluate(() => window.__map.state().lod!.pending), {
          timeout: 5000,
        })
        .toBe(0);
      const whileHidden = gate.hits();
      await page.waitForTimeout(1000);
      expect(gate.hits()).toBe(whileHidden);
      gate.release();
      await page.bringToFront();
      await expect
        .poll(() => page.evaluate(() => document.visibilityState), {
          timeout: 3000,
        })
        .toBe("visible");
      await recovered(page, detail.anchor);
      await attachCanvas(page, info, "visible-resumed-detail");
    } finally {
      await gate.close();
      await covering?.close();
      if (!page.isClosed()) await page.bringToFront();
    }
  });
});
