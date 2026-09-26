import assert from "node:assert/strict";
import { test } from "node:test";
import { createContinuityGuard, sameCamera } from "./check-lod-scale.mjs";

const url = "http://127.0.0.1:5195/?lod=/maps/synthetic/lod.json&players=off";
const expectedCamera = {
  cx: 64,
  cz: 64,
  scale: 6,
  elevation: 45,
  azimuth: 330,
};

function snapshot({
  timeOrigin = 1000,
  camera = expectedCamera,
  draws = 18441,
  tileUploads = 3763,
  decodeMs = 5589.6,
  peakBytes = 182680356,
} = {}) {
  return {
    timeOrigin,
    state: {
      ...camera,
      draws,
      lod: { tileUploads, decodeMs, memory: { peakBytes } },
    },
  };
}

function started() {
  const run = { progress: { cycle: 25, phase: "far-sw", step: "settle" } };
  const guard = createContinuityGuard(run);
  guard.navigated(url);
  guard.observe(snapshot());
  return { run, guard };
}

test("initial blank-page setup is allowed, but navigating back to it invalidates the run", () => {
  const run = {};
  const guard = createContinuityGuard(run);
  guard.navigated("about:blank");
  guard.navigated(url);
  guard.observe(snapshot());
  assert.equal(run.continuity.mainFrameNavigations, 1);
  guard.navigated("about:blank");
  assert.throws(guard.check, /Scale run invalidated/);
});

test("stable navigation cycles keep bounded recent evidence after the full-checkpoint cap", () => {
  const { run, guard } = started();
  for (let cycle = 26; cycle <= 300; cycle++) {
    run.progress = { cycle, phase: "spawn-fine", step: "idle" };
    guard.observe(
      snapshot({
        draws: 18441 + cycle,
        tileUploads: 3763 + cycle,
        decodeMs: 5589.6 + cycle,
        peakBytes: 182680356 + cycle,
      }),
    );
  }
  assert.doesNotThrow(guard.check);
  assert.equal(run.continuity.failure, null);
  assert.equal(run.continuity.mainFrameNavigations, 1);
  assert.equal(run.continuity.recentObservations.length, 16);
  assert.equal(run.continuity.recentObservations[0].progress.cycle, 285);
  assert.equal(run.continuity.recentObservations.at(-1).progress.cycle, 300);
  assert.equal(run.peakBytes, 182680656);
  run.progress.step = "later";
  assert.equal(run.continuity.recentObservations.at(-1).progress.step, "idle");
});

test("a same-URL reload invalidates endurance even before the camera changes", () => {
  const { run, guard } = started();
  run.progress = { cycle: 40, phase: "spawn-fine", step: "aim" };
  guard.navigated(url);
  assert.throws(guard.check, /main-frame navigation after startup.*reload/);
  assert.throws(() => guard.observe(snapshot()), /Scale run invalidated/);
  assert.deepEqual(run.continuity.failure.progress, run.progress);
  assert.equal(run.continuity.recentNavigations.length, 2);
  assert.equal(run.continuity.recentNavigations[1].url, url);
});

test("document identity detects replacement even if a navigation event was missed", () => {
  const { run, guard } = started();
  assert.throws(
    () => guard.observe(snapshot({ timeOrigin: 2000 })),
    /document time origin changed from 1000 to 2000/,
  );
  assert.equal(run.continuity.recentObservations.at(-1).timeOrigin, 2000);
  assert.throws(guard.check, /Scale run invalidated/);
});

test("the observed endurance counter-reset signature is not mislabeled as camera drift", () => {
  const { run, guard } = started();
  run.progress = { cycle: 40, phase: "spawn-fine", step: "settle" };
  const restarted = snapshot({
    camera: { ...expectedCamera, cx: 0, cz: 0, scale: 0.0632295719844358 },
    draws: 69,
    tileUploads: 20,
    decodeMs: 13.300000667572021,
    peakBytes: 127572886,
  });
  assert.throws(
    () => guard.observe(restarted),
    /cumulative counters regressed \(draws, tileUploads, decodeMs, peakBytes\)/,
  );
  assert.equal(run.peakBytes, 182680356);
  assert.equal(run.continuity.recentObservations.at(-1).camera.cx, 0);
  assert.equal(run.continuity.failure.progress.cycle, 40);
  assert.throws(() => guard.observe(snapshot()), /Scale run invalidated/);
});

test("each cumulative counter independently detects a reset", () => {
  for (const key of ["draws", "tileUploads", "decodeMs", "peakBytes"]) {
    const { guard } = started();
    assert.throws(
      () => guard.observe(snapshot({ [key]: 0 })),
      new RegExp(`counters regressed \\(${key}\\)`),
    );
  }
});

test("real camera and lighting changes still fail with actual and expected values", () => {
  const { guard } = started();
  for (const key of Object.keys(expectedCamera)) {
    const changed = { ...expectedCamera, [key]: expectedCamera[key] + 1 };
    assert.doesNotThrow(() => guard.observe(snapshot({ camera: changed })));
    assert.throws(
      () => sameCamera(changed, expectedCamera),
      new RegExp(
        `Camera/lighting changed unexpectedly: ${key}; expected .* got`,
      ),
    );
  }
  assert.doesNotThrow(() => sameCamera({ cx: 1e-7 }, { cx: 0 }));
  for (const cx of [1e-6, -1e-6, Number.NaN, Infinity])
    assert.throws(
      () => sameCamera({ cx }, { cx: 0 }),
      /changed unexpectedly: cx/,
    );
});

test("navigation diagnostics stay bounded and retain the first invalidation", () => {
  const { run, guard } = started();
  for (let cycle = 26; cycle <= 50; cycle++) {
    run.progress = { cycle, phase: "fit", step: "settle" };
    guard.navigated(url);
  }
  assert.equal(run.continuity.mainFrameNavigations, 26);
  assert.equal(run.continuity.recentNavigations.length, 8);
  assert.equal(run.continuity.failure.progress.cycle, 26);
  assert.equal(run.continuity.recentNavigations.at(-1).progress.cycle, 50);
  assert.throws(guard.check, /Scale run invalidated/);
});
