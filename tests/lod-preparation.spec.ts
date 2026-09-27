import { test, expect, type Page } from "@playwright/test";
import { PNG } from "pngjs";
import type { LodView } from "../web/src/lod/view";

interface PreparationHarness {
  draw(cx?: number, azimuth?: number): boolean;
  upload(kind: "height" | "surface", z?: number): void;
  state(): {
    draws: number;
    requests: number;
    notices: number;
    retiredEvents: number;
    resolved: number;
    errors: string[];
    picked: ReturnType<LodView["inspect"]>;
    needsFrame: boolean;
    lod: LodView["stats"];
  };
  destroy(): void;
}
declare global {
  interface Window {
    __lodPreparation: PreparationHarness;
  }
}

async function retired(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = window.__lodPreparation.state();
        return [state.lod.gpuPending, state.lod.retiringBytes];
      }),
    )
    .toEqual([0, 0]);
}

test("height preparation preserves presentation, live picking, and retirement without idle frames", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/lod-preparation-test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<canvas id="map" width="32" height="32"></canvas>',
    }),
  );
  await page.goto("/lod-preparation-test");
  await page.evaluate(async () => {
    const gpuURL = "/pkg/surface_gpu.js";
    const viewURL = "/src/lod/view.ts";
    const memoryURL = "/src/lod/memory.ts";
    const pickingURL = "/src/lod/decoder-data.ts";
    const liveURL = "/src/lod/live.ts";
    const { default: init, LodRenderer } = (await import(
      gpuURL
    )) as typeof import("../web/pkg/surface_gpu.js");
    const { LodView } = (await import(
      viewURL
    )) as typeof import("../web/src/lod/view.ts");
    const { MemoryLedger } = (await import(
      memoryURL
    )) as typeof import("../web/src/lod/memory.ts");
    const { surfacePicking } = (await import(
      pickingURL
    )) as typeof import("../web/src/lod/decoder-data.ts");
    const { chunkStamp } = (await import(
      liveURL
    )) as typeof import("../web/src/lod/live.ts");
    const wasm = await init();
    const atlas = new OffscreenCanvas(32, 32);
    const context = atlas.getContext("2d")!;
    context.fillStyle = "#cc331a";
    context.fillRect(0, 0, 32, 32);
    const renderer = await LodRenderer.create(
      document.querySelector<HTMLCanvasElement>("#map")!,
      new Float32Array([0, 0, 1, 1, 0.5, 0.4, 0.5, 1, 0, 0, 0, 0]),
      await createImageBitmap(atlas),
    );
    const native = renderer as typeof renderer & { needs_frame(): boolean };
    if (typeof native.needs_frame !== "function")
      throw Error("Preparation regression requires rebuilt WASM bindings");
    const key = { level: 0, x: 0, z: 0 };
    const ref = { url: "unused", sha256: "a".repeat(64), bytes: 1 };
    const root: import("../web/src/lod/protocol").LodManifest = {
      kind: "surface-lod",
      format_version: 1,
      name: "Preparation fixture",
      bounds: [0, 0, 2048, 2048],
      spawn: [64, 0, 64],
      source_sha256: ref.sha256,
      generation: "synthetic",
      revision: 1,
      appearance_version: "1",
      height_range: [0, 512],
      atlas: ref,
      material_count: 1,
      catalog: [],
      roots: [{ key, index: ref }],
    };
    const words = (coverage: number) => {
      const result = new Uint32Array(128 * 128 * 8);
      for (let i = 0; i < 128 * 128; i++) {
        result[i * 8 + 2] = 0xffffff;
        result[i * 8 + 7] = coverage;
      }
      return result;
    };
    const baseline = words(1);
    renderer.set_world(new Int32Array(root.bounds), 512);
    renderer.replace_surface(
      0,
      0,
      0,
      baseline,
      new Uint32Array(128 * 128).fill(1 << 16),
    );
    renderer.render(
      64,
      64,
      1,
      32,
      32,
      false,
      true,
      45,
      90,
      0.55,
      false,
      0.5,
      0.25,
    );
    let draws = 0,
      requests = 0,
      notices = 0,
      retiredEvents = 0,
      resolved = 0;
    const errors: string[] = [];
    window.addEventListener("surface-lod-retired", () => retiredEvents++);
    const ledger = new MemoryLedger();
    // Exercise real draw/integrate/finishUpload/accounting with a fixed synthetic
    // cut. Discovery is outside this regression; no fetch implementation is mocked.
    const view = Reflect.construct(LodView, [
      root,
      new URL("/", location.href),
      renderer,
      wasm.memory,
      ledger,
      () => requests++,
      () => notices++,
    ]) as LodView;
    Reflect.set(view, "schedulePlan", () => {});
    Reflect.set(view, "plan", () => {});
    Reflect.set(view, "updateCut", () => {});
    Reflect.set(view, "cut", [key]);
    const chunks = Array.from({ length: 64 }, (_, i) => ({
      ...ref,
      cx: i % 8,
      cz: Math.floor(i / 8),
    }));
    const stamp = chunkStamp(chunks);
    const pick = surfacePicking(baseline, "detail", 1).pick;
    Reflect.get(view, "tiles").set("0/0/0", {
      key,
      hash: ref.sha256,
      pick,
      last: 0,
      catalog: [],
      chunks: stamp,
    });
    Reflect.get(view, "heights").set("0/0/0", { key, hash: ref.sha256 });
    if (!ledger.set("pick:0/0/0", "cpu", pick.byteLength + stamp.byteLength))
      throw Error("Synthetic picking admission failed");
    window.__lodPreparation = {
      draw(cx = 64, azimuth = 90) {
        const rendered = view.draw(
          {
            cx,
            cz: 64,
            scale: 1,
            width: 32,
            height: 32,
            dpr: 1,
            shadows: true,
            elevation: 45,
            azimuth,
          },
          false,
          0.55,
          false,
          0.5,
          0.25,
        );
        if (rendered) draws++;
        return rendered;
      },
      upload(kind, z = 3) {
        const nextKey = kind === "height" ? { level: 0, x: 3, z } : key;
        const next = words(2);
        if (!ledger.tryReserve("job", "transit", 1024 * 1024))
          throw Error("Synthetic upload admission failed");
        Reflect.set(view, "upload", {
          demand: {
            key: nextKey,
            ref,
            kind: kind === "height" ? "height" : "detail",
            priority: 0,
          },
          result:
            kind === "height"
              ? {
                  id: 1,
                  words: new Uint32Array(128 * 128).fill(1 << 16),
                  wasmBytes: 0,
                  decodeMs: 0,
                }
              : {
                  id: 2,
                  updateKind: "surface",
                  words: next,
                  pick: surfacePicking(next, "detail", 1).pick,
                  heightWords: new Uint32Array(128 * 128).fill(
                    (2 << 16) | 32768,
                  ),
                  wasmBytes: 0,
                  decodeMs: 0,
                },
          node: { key: nextKey, data: ref, height: ref, children: [], chunks },
          catalog: [],
          resolve: () => resolved++,
          reject: (error: Error) => errors.push(error.message),
        });
      },
      state: () => ({
        draws,
        requests,
        notices,
        retiredEvents,
        resolved,
        errors,
        picked: view.inspect(64, 64),
        needsFrame: native.needs_frame(),
        lod: view.stats,
      }),
      destroy: () => view.destroy(),
    };
  });
  await retired(page);
  expect(await page.evaluate(() => window.__lodPreparation.draw())).toBe(true);
  await retired(page);
  const state = () => page.evaluate(() => window.__lodPreparation.state());
  const baseline = await state();
  const pixels = async () =>
    PNG.sync.read(await page.locator("#map").screenshot()).data;
  const beforePixels = await pixels();
  expect(beforePixels.some((v, i) => i % 4 !== 3 && v > 40)).toBe(true);
  expect(baseline.picked?.present).toBe(true);
  for (const z of [3, 4]) {
    const before = await state();
    expect(
      await page.evaluate((z) => {
        window.__lodPreparation.upload("height", z);
        return window.__lodPreparation.draw();
      }, z),
    ).toBe(false);
    await retired(page);
    const after = await state();
    expect(after.draws).toBe(baseline.draws);
    expect(after.lod.gpuProgress.submittedSerial).toBe(
      before.lod.gpuProgress.submittedSerial + 1,
    );
    expect(after.resolved).toBe(before.resolved + 1);
    expect(after.notices).toBe(before.notices + 1);
    expect(after.requests).toBe(before.requests);
    expect(after.lod.preparations).toBe(0);
    expect(after.lod.queuedUpload).toBe(false);
    expect(after.needsFrame).toBe(false);
    expect(after.retiredEvents).toBeGreaterThan(before.retiredEvents);
    expect(after.lod.memory.entries.some((entry) => entry.id === "job")).toBe(
      false,
    );
    expect(after.lod.memory.totalBytes).toBeLessThanOrEqual(200000000);
    expect(await pixels()).toEqual(beforePixels);
  }
  const idle = await state();
  expect(await page.evaluate(() => window.__lodPreparation.draw())).toBe(false);
  const afterIdle = await state();
  expect(afterIdle.lod.gpuProgress.submittedSerial).toBe(
    idle.lod.gpuProgress.submittedSerial,
  );
  expect(afterIdle.requests).toBe(idle.requests);
  expect(await page.evaluate(() => window.__lodPreparation.draw(65))).toBe(
    true,
  );
  await retired(page);
  expect(await page.evaluate(() => window.__lodPreparation.draw(65, 180))).toBe(
    true,
  );
  await retired(page);
  const beforeLive = await state();
  expect(
    await page.evaluate(() => {
      window.__lodPreparation.upload("surface");
      return window.__lodPreparation.state().picked?.present;
    }),
  ).toBe(true);
  expect(await page.evaluate(() => window.__lodPreparation.draw(65, 180))).toBe(
    true,
  );
  await retired(page);
  const live = await state();
  expect(live.picked?.present).toBe(false);
  expect(live.resolved).toBe(beforeLive.resolved + 1);
  expect(live.lod.gpuProgress.submittedSerial).toBe(
    beforeLive.lod.gpuProgress.submittedSerial + 1,
  );
  expect(live.lod.gpuProgress.completedSerial).toBe(
    live.lod.gpuProgress.submittedSerial,
  );
  expect(
    live.lod.logicalOccupancy.pickingBytes +
      live.lod.logicalOccupancy.chunkIndexBytes,
  ).toBe(
    live.lod.memory.entries
      .filter((entry) => entry.id.startsWith("pick:"))
      .reduce((sum, entry) => sum + entry.capacityBytes, 0),
  );
  expect(await pixels()).not.toEqual(beforePixels);
  expect(live.errors).toEqual([]);
  expect(errors).toEqual([]);
  await page.evaluate(() => window.__lodPreparation.destroy());
});
