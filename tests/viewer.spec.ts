import { test, expect } from "@playwright/test";
import { PNG } from "pngjs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const fixture = "/?map=/maps/fixture/manifest.json";
async function setAzimuth(
  page: import("@playwright/test").Page,
  angle: number,
) {
  const dial = page.getByRole("slider", { name: "Sun azimuth" });
  const box = (await dial.boundingBox())!;
  const radians = (angle * Math.PI) / 180;
  const radius = Math.min(box.width, box.height) * 0.34;
  // Pixel checks need one chosen bearing; keyboard behavior has its own dial test.
  await dial.click({
    position: {
      x: box.width / 2 + Math.sin(radians) * radius,
      y: box.height / 2 - Math.cos(radians) * radius,
    },
  });
}
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
  await page
    .getByRole("button", { name: "Lighting and color", exact: true })
    .click();
  await page.getByLabel("Color treatment").selectOption("original");
  await page
    .getByRole("button", { name: "Lighting and color", exact: true })
    .click();
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
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
  await ready(page);
  // Drain interaction/region-upload draws before measuring a genuinely idle view.
  // A wall-clock delay can finish before the next frame on software-rendered CI.
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
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

test("one-block sand ledge has partial shadows and elevation changes their reach", async ({
  page,
}) => {
  await page.goto(fixture);
  await ready(page);
  await page.evaluate(() => {
    const s = window.__map.state() as { cx: number; cz: number; scale: number };
    window.__map.pan(-111.5 - s.cx, -207.5 - s.cz);
    window.__map.zoom(80 / s.scale);
  });
  await page
    .getByRole("button", { name: "Block borders", exact: true })
    .click();
  const controls = page.getByRole("button", {
    name: "Lighting and color",
    exact: true,
  });
  await controls.click();
  // Isolate physically traced cast shadows from the independent contact accents.
  await page.getByLabel("Terrain relief").press("Home");
  await setAzimuth(page, 315);
  await page.getByLabel("Color treatment").selectOption("original");
  await controls.click();
  const sample = async (u: number, v: number) => {
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const png = PNG.sync.read(await page.locator("canvas").screenshot());
    const x = Math.floor(png.width / 2 + (u - 0.5) * 80),
      y = Math.floor(png.height / 2 + (v - 0.5) * 80);
    const i = (y * png.width + x) * 4;
    return [...png.data.subarray(i, i + 3)].reduce((s, c) => s + c, 0) / 3;
  };
  const lit = await sample(0.9, 0.8);
  const shaded45 = await sample(0.55, 0.8);
  expect(lit - shaded45).toBeGreaterThan(65);
  await page.screenshot({ path: "test-results/sand-ledge-45.png" });
  await controls.click();
  const elevation = page.getByLabel("Sun elevation");
  await elevation.press("End");
  await elevation.press("ArrowLeft");
  await elevation.press("ArrowLeft");
  await elevation.press("ArrowLeft");
  await expect(page.locator("#elevation-value")).toHaveText("60°");
  await controls.click();
  expect(await sample(0.55, 0.8)).toBeGreaterThan(shaded45 + 65);
  expect(lit - (await sample(0.2, 0.8))).toBeGreaterThan(65);
  await page.screenshot({ path: "test-results/sand-ledge-60.png" });
  await controls.click();
  await page.getByLabel("Shadow strength").press("Home");
  await page.getByLabel("Color treatment").selectOption("vivid");
  await controls.click();
  expect(await sample(0.2, 0.8)).toBeGreaterThan(shaded45 + 65);
  await page.setViewportSize({ width: 390, height: 844 });
  await controls.click();
  await expect(
    page.getByRole("region", { name: "Lighting and color settings" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: "test-results/lighting-mobile.png" });
});
test("sun azimuth is clockwise from north in rendered pixels and raw application state", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(fixture);
  await ready(page);
  await page.evaluate(() => {
    const s = window.__map.state() as { cx: number; cz: number; scale: number };
    window.__map.pan(-155.5 - s.cx, -155.5 - s.cz);
    window.__map.zoom(40 / s.scale);
  });
  await page
    .getByRole("button", { name: "Block borders", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Lighting and color", exact: true })
    .click();
  const dial = page.getByRole("slider", { name: "Sun azimuth" });
  await expect(dial).toHaveAttribute("aria-valuenow", "330");
  await expect(page.locator("#azimuth-value")).toHaveText("330°");
  await expect(dial).toHaveAttribute("aria-valuemin", "0");
  await expect(dial).toHaveAttribute("aria-valuemax", "359");
  const shots = new Map<number, PNG>();
  // Explicit down-sun offsets independently encode the four compass expectations.
  const cardinalShadows = new Map([
    [0, [0, 2.5]], // North sun casts south.
    [90, [-2.5, 0]], // East sun casts west.
    [180, [0, -2.5]], // South sun casts north.
    [270, [2.5, 0]], // West sun casts east.
    [360, [0, 2.5]],
  ]);
  for (const angle of [0, 90, 180, 270, 17, 45, 135, 225, 315, 330, 359, 360]) {
    if (angle === 360) {
      await dial.press("End");
      await dial.press("ArrowRight");
    } else await setAzimuth(page, angle);
    await expect(page.locator("#azimuth-value")).toHaveText(`${angle % 360}°`);
    expect(await page.evaluate(() => window.__map.state())).toMatchObject({
      azimuth: angle % 360,
      azimuthConvention: "north-clockwise",
    });
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const bytes = await page.locator("canvas").screenshot();
    const png = PNG.sync.read(bytes);
    const radians = (angle * Math.PI) / 180;
    const [dx, dz] = cardinalShadows.get(angle) ?? [
      -Math.sin(radians) * 2.5,
      Math.cos(radians) * 2.5,
    ];
    const sample = (sign: number) => {
      const x = Math.floor(png.width / 2 + dx * 40 * sign);
      const y = Math.floor(png.height / 2 + dz * 40 * sign);
      const i = (y * png.width + x) * 4;
      return [...png.data.subarray(i, i + 3)].reduce((s, v) => s + v, 0) / 3;
    };
    expect(
      sample(-1) - sample(1),
      `shadow side at ${angle} degrees`,
    ).toBeGreaterThan(55);
    if (angle === 0 || angle === 360) shots.set(angle, png);
  }
  // Compare the terrain around the column, excluding the lighting panel's label.
  const width = shots.get(0)!.width;
  for (let y = 250; y < 400; y++) {
    expect(
      shots.get(0)!.data.subarray((y * width + 500) * 4, (y * width + 750) * 4),
    ).toEqual(
      shots
        .get(360)!
        .data.subarray((y * width + 500) * 4, (y * width + 750) * 4),
    );
  }
  await dial.press("Home");
  await dial.press("ArrowRight");
  await expect(page.locator("#azimuth-value")).toHaveText("1°");
  await dial.press("End");
  await expect(page.locator("#azimuth-value")).toHaveText("359°");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dial).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: "test-results/azimuth-mobile.png" });
  expect(errors).toEqual([]);
});

test("terrain relief follows height boundaries and sunlight, with block-scaled width", async ({
  page,
}) => {
  await page.goto(fixture);
  await ready(page);
  await page
    .getByRole("button", { name: "Block borders", exact: true })
    .click();
  await page.getByRole("button", { name: "Sun shadows", exact: true }).click();
  await page
    .getByRole("button", { name: "Lighting and color", exact: true })
    .click();
  await page.getByLabel("Color treatment").selectOption("original");
  const set = async (label: string, value: number) => {
    if (label === "Sun azimuth") return setAzimuth(page, value);
    await page.getByLabel(label).evaluate((input, v) => {
      (input as HTMLInputElement).value = String(v);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, value);
  };
  const aim = async (cx: number, cz: number, scale: number) => {
    await page.evaluate(
      ({ cx, cz, scale }) => {
        const s = window.__map.state() as {
          cx: number;
          cz: number;
          scale: number;
        };
        window.__map.pan(cx - s.cx, cz - s.cz);
        window.__map.zoom(scale / s.scale);
      },
      { cx, cz, scale },
    );
  };
  const shot = async () => {
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const png = PNG.sync.read(await page.locator("canvas").screenshot());
    const s = (await page.evaluate(() => window.__map.state())) as {
      cx: number;
      cz: number;
      scale: number;
    };
    return (x: number, z: number) => {
      const px = Math.floor(png.width / 2 + (x - s.cx) * s.scale);
      const pz = Math.floor(png.height / 2 + (z - s.cz) * s.scale);
      const i = (pz * png.width + px) * 4;
      return [...png.data.subarray(i, i + 3)].reduce((a, b) => a + b, 0) / 3;
    };
  };
  await set("Sun azimuth", 315);
  await aim(-224, -224, 16);
  let sample = await shot();
  const base = sample(-223.5, -223.5);
  expect(sample(-223.875, -223.5) - base).toBeGreaterThan(12);
  expect(sample(-223.875, -223.875) - sample(-223.875, -223.5)).toBeGreaterThan(
    6,
  );
  // The next block is on the same plateau: neither an interior line nor a false rim.
  expect(Math.abs(sample(-222.9375, -223.5) - base)).toBeLessThan(2);
  expect(Math.abs(sample(-224.125, -223.5) - base)).toBeLessThan(2);
  await set("Sun azimuth", 330);
  sample = await shot();
  expect(sample(-223.5, -223.875)).toBeGreaterThan(
    sample(-223.875, -223.5) + 6,
  );
  await set("Sun azimuth", 135);
  sample = await shot();
  expect(Math.abs(sample(-223.875, -223.875) - base)).toBeLessThan(2);
  expect(base - sample(-224.125, -223.5)).toBeGreaterThan(25);
  await aim(-200, -200, 16);
  sample = await shot();
  expect(sample(-200.125, -200.125) - base).toBeGreaterThan(20);
  await set("Sun azimuth", 315);
  sample = await shot();
  expect(base - sample(-199.875, -200.5)).toBeGreaterThan(25);
  await aim(-224, -220, 16);
  await set("Sun azimuth", 270);
  for (const scale of [4, 16]) {
    await aim(-224, -220, scale);
    sample = await shot();
    const litPixels = Array.from(
      { length: scale },
      (_, i) => sample(-224 + (i + 0.5) / scale, -220.5) > base + 5,
    ).filter(Boolean).length;
    expect(litPixels).toBe(scale / 4);
  }
  await set("Edge width", 50);
  sample = await shot();
  expect(sample(-223.625, -220.5)).toBeGreaterThan(base + 12);
  expect(Math.abs(sample(-223.375, -220.5) - base)).toBeLessThan(2);
  await set("Terrain relief", 0);
  sample = await shot();
  expect(Math.abs(sample(-223.875, -220.5) - base)).toBeLessThan(2);
  // At overview scales, changing relief must rebuild the cached color mipmaps.
  await aim(-212, -212, 0.8);
  const before = await shot();
  await set("Terrain relief", 100);
  const after = await shot();
  let changed = 0;
  for (let z = -230; z < -194; z++)
    for (let x = -230; x < -194; x++)
      if (Math.abs(after(x, z) - before(x, z)) > 2) changed++;
  expect(changed).toBeGreaterThan(20);
  // Synthetic water deliberately has a height step: relief must not outline it.
  await aim(-32, -64, 16);
  const waterOn = await shot();
  await set("Terrain relief", 0);
  const waterOff = await shot();
  for (const x of [-32.125, -31.875, -31.5])
    expect(Math.abs(waterOn(x, -63.5) - waterOff(x, -63.5))).toBeLessThan(2);
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 844, height: 390 },
  ]) {
    await page.setViewportSize(viewport);
    await page.getByLabel("Color treatment").scrollIntoViewIfNeeded();
    const panel = await page.locator("#lighting").boundingBox();
    expect(panel!.y + panel!.height).toBeLessThan(viewport.height - 30);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
});

test("Vivid sand gains rim contrast without changing other materials or Original", async ({
  page,
}) => {
  let adjusted = false;
  await page.route(
    (url) => url.pathname === "/maps/fixture/manifest.json",
    async (route) => {
      const response = await route.fetch();
      const m = await response.json();
      // Remove only the sand classification to recreate the previous color treatment.
      if (!adjusted)
        m.materials.find((m: { name: string }) => m.name === "Sand").name =
          "Baseline sand";
      await route.fulfill({ json: m });
    },
  );
  const aim = async (cx: number, cz: number, scale: number) => {
    await page.evaluate(
      ({ cx, cz, scale }) => {
        const s = window.__map.state() as {
          cx: number;
          cz: number;
          scale: number;
        };
        window.__map.pan(cx - s.cx, cz - s.cz);
        window.__map.zoom(scale / s.scale);
      },
      { cx, cz, scale },
    );
  };
  const capture = async () => {
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const png = PNG.sync.read(await page.locator("canvas").screenshot());
    const s = (await page.evaluate(() => window.__map.state())) as {
      cx: number;
      cz: number;
      scale: number;
    };
    return (x: number, z: number) => {
      const px = Math.floor(png.width / 2 + (x - s.cx) * s.scale);
      const pz = Math.floor(png.height / 2 + (z - s.cz) * s.scale);
      return [
        ...png.data.subarray(
          (pz * png.width + px) * 4,
          (pz * png.width + px) * 4 + 3,
        ),
      ];
    };
  };
  const results: {
    mode: string;
    adjusted: boolean;
    colors: number[][];
    contrast: number;
  }[] = [];
  const mean = (c: number[]) => c.reduce((a, b) => a + b, 0) / 3;
  for (const corrected of [false, true]) {
    adjusted = corrected;
    await page.goto(fixture);
    await ready(page);
    await page
      .getByRole("button", { name: "Block borders", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Sun shadows", exact: true })
      .click();
    for (const mode of ["original", "vivid"]) {
      await page
        .getByRole("button", { name: "Lighting and color", exact: true })
        .click();
      await page.getByLabel("Color treatment").selectOption(mode);
      await page
        .getByRole("button", { name: "Lighting and color", exact: true })
        .click();
      await aim(-128, -128, 2);
      const sample = await capture();
      const colors = [
        [-222.5, -222.5],
        [-240.5, -128.5],
        [-160.5, -128.5],
        [-32.5, -64.5],
      ].map(([x, z]) => sample(x, z));
      await aim(-224, -224, 16);
      const close = await capture();
      const contrast =
        mean(close(-223.5, -223.875)) - mean(close(-223.5, -223.5));
      results.push({ mode, adjusted, colors, contrast });
    }
  }
  for (const mode of ["original", "vivid"]) {
    const before = results.find((r) => r.mode === mode && !r.adjusted)!;
    const after = results.find((r) => r.mode === mode && r.adjusted)!;
    for (let material = mode === "vivid" ? 1 : 0; material < 4; material++)
      for (let channel = 0; channel < 3; channel++)
        expect(
          Math.abs(
            after.colors[material][channel] - before.colors[material][channel],
          ),
        ).toBeLessThanOrEqual(1);
    if (mode === "vivid") {
      expect(mean(before.colors[0]) - mean(after.colors[0])).toBeGreaterThan(
        20,
      );
      expect(after.contrast - before.contrast).toBeGreaterThan(4);
    } else {
      expect(Math.abs(after.contrast - before.contrast)).toBeLessThanOrEqual(1);
    }
  }
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
