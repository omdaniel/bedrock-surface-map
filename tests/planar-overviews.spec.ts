import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PNG } from "pngjs";
import { MAP_CACHE_BYTES, WORKING_BYTES } from "../web/src/cache-budget";
import type { LiveRoot } from "../web/src/terrain";

const fixture = "/?map=/maps/fixture/manifest.json&players=off";
type State = ReturnType<Window["__map"]["state"]>;

async function state(page: Page) {
  return page.evaluate(() => window.__map.state());
}

function camera(s: State) {
  return {
    cx: s.cx,
    cz: s.cz,
    elevation: s.elevation,
    azimuth: s.azimuth,
    shadowStrength: s.shadowStrength,
    vivid: s.vivid,
    reliefStrength: s.reliefStrength,
    reliefWidth: s.reliefWidth,
  };
}

async function settled(page: Page, stride: number, cached: number) {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const s = window.__map?.state();
          return {
            ready: window.__map?.ready,
            stride: s?.stride,
            cached: s?.cached,
            switching: s?.switchingResolution,
            pending: s?.pending,
            renderPending: s?.renderPending,
            terrainBusy: s?.terrain?.busy ?? false,
            failures: s?.failures,
            message: document.querySelector("#message-text")?.textContent,
          };
        }),
      { timeout: 45000 },
    )
    .toMatchObject({
      ready: true,
      stride,
      cached,
      switching: false,
      pending: 0,
      renderPending: false,
      terrainBusy: false,
      failures: [],
    });
  await expect(page.locator("#message")).toBeHidden();
  const s = await state(page);
  expect(s.firstVisible).not.toBeNull();
  expect(s.memory).toBeGreaterThan(0);
  expect(s.reservedMemory).toBe(WORKING_BYTES);
  expect(s.memory + s.reservedMemory).toBeLessThanOrEqual(MAP_CACHE_BYTES);
  return s;
}

async function zoomTo(page: Page, scale: number) {
  const before = await state(page);
  const immediate = await page.evaluate((target) => {
    window.__map.zoom(target / window.__map.state().scale);
    return window.__map.state();
  }, scale);
  // Observe the handler as well as the eventual frame: no silent camera rollback.
  expect(immediate.scale).toBeCloseTo(scale, 10);
  expect(camera(immediate)).toEqual(camera(before));
  if (immediate.stride !== before.stride)
    expect(immediate.switchingResolution).toBe(true);
  return before;
}

async function screenshot(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`);
  const bytes = await page.locator("#map").screenshot({ path });
  await info.attach(name, { path, contentType: "image/png" });
  return PNG.sync.read(bytes);
}

function fixedFixtureBytes(name: "fixture" | "coast") {
  const directory = resolve("web/public/maps", name);
  const manifest = JSON.parse(
    readFileSync(resolve(directory, "manifest.json"), "utf8"),
  );
  const atlas = PNG.sync.read(readFileSync(resolve(directory, manifest.atlas)));
  // Diagnostics charge this fixed atlas mip allocation and 48 bytes per
  // material. Exclude only these; compare actual region + height + picking bytes.
  return (
    (atlas.width * atlas.height * 4 * 21) / 16 + manifest.materials.length * 48
  );
}

function coastPixels(png: PNG, s: State) {
  for (let rz = -2; rz < 2; rz++) {
    for (let rx = -2; rx < 2; rx++) {
      const x = rx * 256 + 96,
        z = rz * 256 + 104;
      const px = Math.floor(png.width / 2 + (x - s.cx) * s.scale);
      const py = Math.floor(png.height / 2 + (z - s.cz) * s.scale);
      const i = (py * png.width + px) * 4;
      const [r, g, b] = png.data.subarray(i, i + 3);
      const shore = x + z + Math.trunc(Math.sin(x / 90) * 32);
      const visible =
        shore < 0
          ? b > g && g > r
          : shore < 240
            ? r > g && g > b
            : g > r && g > b;
      expect(visible, `coast region ${rx},${rz}, RGB ${r},${g},${b}`).toBe(
        true,
      );
    }
  }
}

async function fixturePixels(page: Page, info: TestInfo, name: string) {
  const png = await screenshot(page, info, name);
  const s = await state(page);
  const box = (await page.locator("#map").boundingBox())!;
  let grass = 0,
    stone = 0,
    water = 0,
    samples = 0;
  // Sample only the known occupied world rectangle, not toolbar or clear pixels.
  for (let z = -252; z < -4; z += 4) {
    for (let x = -252; x < -4; x += 4) {
      const px = Math.floor(
        ((box.width / 2 + (x - s.cx) * s.scale) * png.width) / box.width,
      );
      const py = Math.floor(
        ((box.height / 2 + (z - s.cz) * s.scale) * png.height) / box.height,
      );
      const i = (py * png.width + px) * 4;
      const [r, g, b, a] = png.data.subarray(i, i + 4);
      expect(a).toBe(255);
      if (g > r * 1.25 && g > b * 1.25 && g > 70) grass++;
      if (Math.max(r, g, b) - Math.min(r, g, b) < 20 && r > 90) stone++;
      if (b > g * 1.1 && g > r * 1.25 && b > 70) water++;
      samples++;
    }
  }
  expect(grass / samples, "fixture grass must remain rendered").toBeGreaterThan(
    0.15,
  );
  expect(stone / samples, "fixture stone must remain rendered").toBeGreaterThan(
    0.15,
  );
  expect(water / samples, "fixture water must remain rendered").toBeGreaterThan(
    0.04,
  );
}

async function pick(page: Page, x: number, z: number, stride: number) {
  const s = await state(page);
  const box = (await page.locator("#map").boundingBox())!;
  await page.mouse.move(
    box.x + box.width / 2 + (x - s.cx) * s.scale,
    box.y + box.height / 2 + (z - s.cz) * s.scale,
  );
  await expect(page.locator("#inspect")).toBeVisible();
  await expect(page.locator("#block-detail")).toHaveText(
    stride === 1 ? "" : `Approximate ${stride} × ${stride}-block surface`,
  );
}

test("fine and stride-2 scenes repeatedly replace resident storage without moving the camera", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(fixture);
  await settled(page, 1, 1);
  // Both scales show the same region, so total GPU+CPU memory is comparable.
  await zoomTo(page, 0.500001);
  const baseline = await settled(page, 1, 1);
  const fixed = fixedFixtureBytes("fixture");
  await expect(page.locator("#scale span")).toHaveText("100 blocks");
  await fixturePixels(page, info, "fine-initial");
  const measurements: State[] = [baseline];
  for (let cycle = 0; cycle < 3; cycle++) {
    const before = await zoomTo(page, 0.5);
    const coarse = await settled(page, 2, 1);
    measurements.push(coarse);
    expect(coarse.scale).toBeCloseTo(0.5, 10);
    expect(camera(coarse)).toEqual(camera(baseline));
    expect(coarse.draws).toBeGreaterThan(before.draws);
    await expect(page.locator("#scale span")).toHaveText("200 blocks");
    // Read actual renderer/picking/height allocations, not the cost estimator.
    // The tiny fixture's 134,640 fixed bytes otherwise dominate this comparison.
    const ratio = (coarse.memory - fixed) / (baseline.memory - fixed);
    expect(ratio).toBeGreaterThan(0.249);
    expect(ratio).toBeLessThan(0.251);
    await fixturePixels(page, info, `stride-2-${cycle}`);
    await pick(page, -220, -140, 2);
    await expect(page.locator("#block-name")).toHaveText("Grass");
    const restore = await zoomTo(page, 0.500001);
    const fine = await settled(page, 1, 1);
    measurements.push(fine);
    expect(fine.scale).toBeCloseTo(baseline.scale, 10);
    expect(camera(fine)).toEqual(camera(baseline));
    expect(fine.draws).toBeGreaterThan(restore.draws);
    expect(fine.memory).toBe(baseline.memory);
    await expect(page.locator("#scale span")).toHaveText("100 blocks");
    await fixturePixels(page, info, `fine-restored-${cycle}`);
    await pick(page, -220, -140, 1);
    await expect(page.locator("#block-name")).toHaveText("Grass");
  }
  await info.attach("resident-memory", {
    body: JSON.stringify(measurements, null, 2),
    contentType: "application/json",
  });
  expect(errors).toEqual([]);
});

test("the 16-region coast stays visible during replacement and uses one reduced footprint", async ({
  page,
}, info) => {
  // npm run fixture -- --coast --output web/public/maps/coast
  let hold = false;
  let held = 0;
  let release!: () => void;
  let gate: Promise<void>;
  const holdRequests = () => {
    hold = true;
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  };
  const geometry = () =>
    page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>("#map")!;
      return {
        viewport: document
          .querySelector("main")!
          .getBoundingClientRect()
          .toJSON(),
        canvas: canvas.getBoundingClientRect().toJSON(),
        width: canvas.width,
        height: canvas.height,
        controls: Object.fromEntries(
          ["#scale", ".north", ".zoom", "header", "footer"].map((selector) => {
            const { x, y } = document
              .querySelector(selector)!
              .getBoundingClientRect();
            return [selector, { x, y }];
          }),
        ),
      };
    });
  await page.route("**/maps/coast/regions/**", async (route) => {
    if (hold) {
      held++;
      await gate;
    }
    await route.continue();
  });
  await page.goto("/?map=/maps/coast/manifest.json&players=off");
  await settled(page, 1, 16);
  await zoomTo(page, 0.500001);
  const fine = await settled(page, 1, 16);
  const originalGeometry = await geometry();
  const original = await screenshot(page, info, "coast-fine");
  coastPixels(original, fine);
  holdRequests();
  try {
    // A wheel event can cross the threshold while a pan frame is already queued.
    // Queue both actions in one turn so the pending frame cannot run first.
    await page.evaluate(() => {
      window.__map.pan(1, 0);
      window.__map.pan(-1, 0);
      window.__map.zoom(0.5 / window.__map.state().scale);
    });
    await expect.poll(() => held).toBeGreaterThan(0);
    const replacing = await state(page);
    expect(replacing.switchingResolution).toBe(true);
    expect(replacing.pending).toBeGreaterThan(0);
    await expect(page.locator("#message-text")).toHaveText(
      "Preparing 2 × 2 overview…",
    );
    const notice = await page.locator("#message").boundingBox();
    const scaleBar = await page.locator("#scale").boundingBox();
    expect(notice!.x).toBe(scaleBar!.x);
    expect(notice!.y).toBeGreaterThan(scaleBar!.y + scaleBar!.height);
    await expect(page.locator("#message")).toHaveCSS(
      "background-color",
      "rgba(0, 0, 0, 0)",
    );
    await expect(page.locator("#message")).toHaveCSS("pointer-events", "none");
    expect(await geometry()).toEqual(originalGeometry);
    const retained = await screenshot(page, info, "coast-replacing");
    coastPixels(retained, fine);
    expect(replacing.draws).toBe(fine.draws);
    expect((await state(page)).draws).toBe(fine.draws);
  } finally {
    hold = false;
    release();
  }
  const coarse = await settled(page, 2, 16);
  expect(await geometry()).toEqual(originalGeometry);
  expect(camera(coarse)).toEqual(camera(fine));
  expect(coarse.scale).toBeCloseTo(0.5, 10);
  const fixed = fixedFixtureBytes("coast");
  const ratio = (coarse.memory - fixed) / (fine.memory - fixed);
  expect(ratio).toBeGreaterThan(0.249);
  expect(ratio).toBeLessThan(0.251);
  const png = await screenshot(page, info, "coast-stride-2");
  coastPixels(png, coarse);
  held = 0;
  holdRequests();
  try {
    await page.evaluate(() => {
      window.__map.pan(1, 0);
      window.__map.pan(-1, 0);
      window.__map.zoom(0.500001 / window.__map.state().scale);
    });
    await expect.poll(() => held).toBeGreaterThan(0);
    await expect(page.locator("#message-text")).toHaveText(
      "Preparing full detail…",
    );
    expect(await geometry()).toEqual(originalGeometry);
    coastPixels(await screenshot(page, info, "coast-refining"), coarse);
    expect((await state(page)).draws).toBe(coarse.draws);
  } finally {
    hold = false;
    release();
  }
  const restored = await settled(page, 1, 16);
  expect(await geometry()).toEqual(originalGeometry);
  expect(camera(restored)).toEqual(camera(fine));
  expect(restored.memory).toBe(fine.memory);
  const restoredPixels = await screenshot(page, info, "coast-restored");
  expect(restoredPixels.data.equals(original.data)).toBe(true);
});

test("dense live terrain reaches stride 4 within budget and returns to fine detail", async ({
  page,
}, info) => {
  test.setTimeout(120000);
  // large_fixture's root-16 is 32x32 regions (8192 square), requiring stride 4.
  // Generate with npm run fixture && node scripts/terrain-fixture.mjs.
  const directory = resolve(".local/terrain-large");
  const root = JSON.parse(
    readFileSync(resolve(directory, "root-16.json"), "utf8"),
  ) as LiveRoot;
  expect(root.regions).toHaveLength(1024);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.route("**/viewer-config.json", (route) =>
    route.fulfill({
      json: {
        terrain: {
          world_id: root.world_id,
          generation: root.generation,
          url: `/api/v1/worlds/${root.world_id}/terrain/manifest.json`,
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
    return route.fulfill({
      body: readFileSync(resolve(directory, "objects", name)),
      contentType: name.endsWith(".png")
        ? "image/png"
        : name.endsWith(".json")
          ? "application/json"
          : "application/octet-stream",
    });
  });
  await page.goto("/?players=off");
  await settled(page, 4, 1024);
  const expectedRegions = () =>
    page.evaluate(
      (regions) => {
        const s = window.__map.state();
        const main = document.querySelector("main")!;
        const dx = main.clientWidth / s.scale / 2;
        const dz = main.clientHeight / s.scale / 2;
        return regions.filter(
          (r) =>
            r.rx * 256 <= s.cx + dx &&
            (r.rx + 1) * 256 >= s.cx - dx &&
            r.rz * 256 <= s.cz + dz &&
            (r.rz + 1) * 256 >= s.cz - dz,
        ).length;
      },
      root.regions.map(({ rx, rz }) => ({ rx, rz })),
    );
  await zoomTo(page, 1);
  const baseline = await settled(page, 1, await expectedRegions());
  const measurements: State[] = [baseline];
  for (const [scale, stride] of [
    [0.3, 2],
    [0.2, 4],
    [1, 1],
  ]) {
    const before = await zoomTo(page, scale);
    const after = await settled(page, stride, await expectedRegions());
    measurements.push(after);
    expect(after.scale).toBeCloseTo(scale, 10);
    expect(camera(after)).toEqual(camera(baseline));
    expect(after.draws).toBeGreaterThan(before.draws);
    expect(after.terrain).not.toBeNull();
    expect(after.terrain!.revision).toBe(root.revision);
    const png = await screenshot(page, info, `dense-stride-${stride}`);
    let green = 0,
      samples = 0;
    // Every central pixel is known grass, including across region boundaries.
    for (let y = png.height / 2 - 80; y < png.height / 2 + 80; y += 2) {
      for (let x = png.width / 2 - 240; x < png.width / 2 + 240; x += 2) {
        const i = (Math.floor(y) * png.width + Math.floor(x)) * 4;
        const [r, g, b] = png.data.subarray(i, i + 3);
        if (g > r * 1.2 && g > b * 1.2 && g > 60) green++;
        samples++;
      }
    }
    expect(
      green / samples,
      "dense terrain must not contain blank region gaps",
    ).toBeGreaterThan(0.95);
    await pick(page, -100, -100, stride);
    await expect(page.locator("#block-name")).toHaveText("grass block");
    await expect(page.locator("#block-pos")).toContainText(" / 64 / ");
  }
  const [, half, quarter, restored] = measurements;
  expect(quarter.cached).toBeGreaterThan(half.cached);
  expect(quarter.memory / half.memory).toBeLessThan(0.75);
  expect(
    quarter.memory / quarter.cached / (half.memory / half.cached),
  ).toBeLessThan(0.3);
  expect(restored.memory).toBe(baseline.memory);
  await info.attach("dense-resident-memory", {
    body: JSON.stringify(measurements, null, 2),
    contentType: "application/json",
  });
  expect(errors).toEqual([]);
});
