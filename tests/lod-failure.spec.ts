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
        anchor,
        ref: node.data,
        url: new URL(node.data.url, base).href,
      };
    current = node.children.find(contains);
  }
  throw Error("Synthetic fixture exceeds the L16 hierarchy");
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

async function recovered(page: Page) {
  await expect
    .poll(() => page.evaluate(() => window.__map.state().lod?.level), {
      timeout: 60_000,
    })
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

async function responsiveCoarse(page: Page) {
  const before = await page.evaluate(() => window.__map.state());
  await page.evaluate(() => window.__map.pan(8, -5));
  await expect
    .poll(() => page.evaluate(() => window.__map.state().draws), {
      timeout: 3000,
    })
    .toBeGreaterThan(before.draws);
  const state = await page.evaluate(() => window.__map.state());
  expect(state.cx).toBeCloseTo(before.cx + 8);
  expect(state.cz).toBeCloseTo(before.cz - 5);
  expect(state.scale).toBeCloseTo(6);
  expect(state.lod!.level).toBeGreaterThan(0);
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
  const body = await page.locator("#map").screenshot({ timeout: 3000 });
  const png = PNG.sync.read(body),
    colors = new Set<string>();
  for (let y = 0; y < png.height; y += 11)
    for (let x = 0; x < png.width; x += 11) {
      const i = (y * png.width + x) * 4;
      colors.add(
        `${png.data[i] >> 3},${png.data[i + 1] >> 3},${png.data[i + 2] >> 3}`,
      );
    }
  expect(
    colors.size,
    "Available coarse terrain must remain rendered",
  ).toBeGreaterThan(20);
  await info.attach(name, { body, contentType: "image/png" });
}

async function delayedPayload(page: Page, url: string) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let hits = 0;
  const matches = (value: URL) => value.href === url;
  const handler = async (route: Route) => {
    hits++;
    await gate;
    // The decoder may have canceled this request while the route was held.
    await route.continue().catch(() => {});
  };
  await page.context().route(matches, handler);
  return {
    hits: () => hits,
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
    const gate = await delayedPayload(page, detail.url);
    try {
      await fine(page);
      await expect.poll(gate.hits, { timeout: 30_000 }).toBeGreaterThan(0);
      const state = await responsiveCoarse(page);
      expect(state.lod!.pending).toBe(1);
      expect(
        state.lod!.memory.entries.find((entry) => entry.id === "job")
          ?.reservationBytes,
      ).toBeGreaterThan(0);
      await attachCanvas(page, info, "slow-payload-coarse-coverage");
      gate.release();
      await recovered(page);
      expect(errors).toEqual([]);
    } finally {
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
        await responsiveCoarse(page);
        await attachCanvas(page, info, `${failure}-coarse-coverage`);
        active = false;
        await recovered(page);
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
      await recovered(page);
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
      await recovered(page);
      await attachCanvas(page, info, "visible-resumed-detail");
    } finally {
      await gate.close();
      await covering?.close();
      if (!page.isClosed()) await page.bringToFront();
    }
  });
});
