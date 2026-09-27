import assert from "node:assert/strict";
import { test } from "node:test";
import { PNG } from "pngjs";
import {
  checkFailures,
  checkMemory,
  checkNonblank,
  checkReleased,
  screenshotStats,
  settledProblems,
} from "./check-lod-safari.mjs";

function state() {
  return {
    ready: true,
    visibility: "visible",
    pending: 0,
    renderPending: false,
    lodRecovering: false,
    memory: 131072,
    lod: {
      firstVisible: 100,
      tiles: 1,
      heights: 0,
      cut: ["2/0/0"],
      pending: 0,
      activeKind: null,
      queuedUpload: false,
      preparations: 0,
      gpuPending: 0,
      retiringBytes: 0,
      gpuProgress: {
        submittedSerial: 4,
        completedSerial: 4,
        oldestInFlightAgeMs: 0,
      },
      memory: {
        limitBytes: 128000000,
        totalBytes: 131072,
        peakBytes: 131072,
        freeBytes: 128000000 - 131072,
        capacityBytes: 131072,
        reservedBytes: 0,
        categories: { cpu: 131072, surface: 0 },
        entries: [
          {
            id: "pick:2/0/0",
            category: "cpu",
            totalBytes: 131072,
            capacityBytes: 131072,
            reservedBytes: 0,
          },
        ],
      },
      logicalOccupancy: {
        pickingBytes: 131072,
        surfaceBytes: 0,
        heightSlots: 0,
        heightSlotCapacity: 128,
      },
    },
  };
}

test("settling rejects each outstanding GPU, preparation, retirement and upload state", () => {
  assert.deepEqual(settledProblems(state()), []);
  assert.deepEqual(settledProblems(null), ["LOD diagnostics absent"]);
  for (const [field, value] of Object.entries({
    firstVisible: null,
    tiles: 0,
    pending: 1,
    activeKind: "tile",
    queuedUpload: true,
    preparations: 1,
    gpuPending: 1,
    retiringBytes: 100,
  })) {
    const valueState = state();
    valueState.lod[field] = value;
    assert.ok(settledProblems(valueState).length > 0, field);
  }
  for (const [field, value] of Object.entries({
    ready: false,
    visibility: "hidden",
    pending: 1,
    renderPending: true,
    lodRecovering: true,
  })) {
    const valueState = state();
    valueState[field] = value;
    assert.ok(
      settledProblems(valueState).includes(
        field === "visibility"
          ? "visible"
          : field === "lodRecovering"
            ? "recovering"
            : field,
      ),
    );
  }
  for (const field of ["completedSerial", "oldestInFlightAgeMs"]) {
    const value = state();
    value.lod.gpuProgress[field] = 1;
    assert.ok(settledProblems(value).includes("submissions"));
  }
  for (const id of ["job", "catalog-job", "resize"]) {
    const value = state();
    value.lod.memory.entries.push({ id });
    assert.ok(settledProblems(value).includes("jobs"));
  }
});

test("memory accepts an operator budget and rejects overruns or inconsistent charges", () => {
  checkMemory(state());
  for (const mutate of [
    (s) => (s.lod.memory.peakBytes = 200000001),
    (s) => (s.lod.memory.limitBytes = 200000001),
    (s) => s.lod.memory.totalBytes++,
    (s) => s.lod.memory.categories.cpu++,
    (s) => s.lod.memory.entries[0].totalBytes++,
    (s) => s.lod.memory.entries.push(s.lod.memory.entries[0]),
    (s) => s.lod.logicalOccupancy.pickingBytes++,
    (s) => s.lod.logicalOccupancy.heightSlots++,
    (s) => (s.memory = NaN),
  ]) {
    const value = state();
    mutate(value);
    assert.throws(() => checkMemory(value));
  }
});

function releasePair() {
  return {
    fine: {
      lod: {
        level: 0,
        tiles: 8,
        cut: ["0/0/0"],
        catalogPages: 1,
        materialDescriptors: 8,
        memory: { totalBytes: 1000000, entries: [{ id: "pick:0/0/0" }] },
      },
    },
    coarse: {
      lod: {
        level: 2,
        tiles: 4,
        cut: ["2/0/0"],
        previousCut: [],
        heightKeys: ["2/0/0"],
        edgeSources: ["2/0/0"],
        catalogPages: 0,
        materialDescriptors: 0,
        memory: { totalBytes: 500000, entries: [{ id: "pick:2/0/0" }] },
      },
    },
  };
}

test("coarsening must release exact picking, height/edge sources and catalog charges", () => {
  const pair = releasePair();
  checkReleased(pair.fine, pair.coarse);
  for (const mutate of [
    (s) => s.lod.memory.entries.push({ id: "pick:0/0/0" }),
    (s) => s.lod.memory.entries.push({ id: "catalog:0" }),
    (s) => s.lod.heightKeys.push("0/0/0"),
    (s) => s.lod.edgeSources.push("0/0/0"),
    (s) => s.lod.previousCut.push("0/0/0"),
    (s) => (s.lod.catalogPages = 1),
    (s) => (s.lod.materialDescriptors = 8),
    (s) => (s.lod.memory.totalBytes = pair.fine.lod.memory.totalBytes),
  ]) {
    const changed = releasePair();
    mutate(changed.coarse);
    assert.throws(() => checkReleased(changed.fine, changed.coarse));
  }
});

test("nonblank sampling excludes colorful UI outside a blank canvas", () => {
  const png = new PNG({ width: 100, height: 100 });
  const geometry = {
    width: 100,
    height: 100,
    rect: { x: 0, y: 20, width: 100, height: 80 },
  };
  for (let y = 0; y < 100; y++)
    for (let x = 0; x < 100; x++) {
      const i = (y * 100 + x) * 4;
      png.data.set(y < 20 ? [x * 2, y * 12, x + y, 255] : [40, 40, 40, 255], i);
    }
  const blank = screenshotStats(png, geometry);
  assert.equal(blank.colors, 1);
  assert.equal(blank.colored, 0);
  assert.throws(() => checkNonblank(blank));
  for (let y = 32; y < 88; y++)
    for (let x = 15; x < 85; x++)
      png.data.set([x * 2, y * 2, x + y, 255], (y * 100 + x) * 4);
  const terrain = screenshotStats(png, geometry);
  assert.ok(terrain.colors > 20 && terrain.colored > 20);
  checkNonblank(terrain);
  assert.throws(() => screenshotStats(png, { ...geometry, width: 200 }));
});

test("low-palette terrain retains exact PNG variation lost by color bucketing", () => {
  const png = new PNG({ width: 100, height: 100 });
  for (let y = 0; y < 100; y++)
    for (let x = 0; x < 100; x++)
      png.data.set([30 + (x % 31), 90, 40, 255], (y * 100 + x) * 4);
  const result = screenshotStats(png, {
    width: 100,
    height: 100,
    rect: { x: 0, y: 0, width: 100, height: 100 },
  });
  assert.ok(result.colors > 20 && result.colored > 20);
  assert.ok(result.quantizedColors < 20);
  checkNonblank(result);
});

test("application failures, browser errors, lost diagnostics and unexpected recovery fail closed", () => {
  const healthy = {
    failures: [],
    browserErrors: [],
    lodRecoveries: 0,
    retry: false,
    lod: { failures: [] },
  };
  checkFailures(healthy);
  for (const patch of [
    { failures: ["decode failed"] },
    { browserErrors: [{ kind: "rejection", message: "bad tile" }] },
    { browserErrors: undefined },
    { lodRecoveries: 1 },
    { retry: true },
    { lod: { failures: ["upload failed"] } },
  ])
    assert.throws(() => checkFailures({ ...healthy, ...patch }));
});
