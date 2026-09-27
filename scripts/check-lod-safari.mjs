import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { PNG } from "pngjs";
import { verificationConfig } from "./verification-config.mjs";

const CEILING = 200_000_000;
const camera = ({ cx, cz, scale }) => ({ cx, cz, scale });
const near = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`);

export function checkFailures(state) {
  assert.deepEqual(state.failures, [], "Application failures");
  assert.deepEqual(state.browserErrors, [], "Browser application errors");
  assert.equal(state.lodRecoveries, 0, "Unexpected device recovery");
  assert.equal(state.retry, false, "Application offers Retry");
  if (state.lod) assert.deepEqual(state.lod.failures, [], "LOD failures");
}

export function settledProblems(state) {
  const lod = state?.lod;
  if (!lod) return ["LOD diagnostics absent"];
  return Object.entries({
    ready: state.ready === true,
    visible: state.visibility === "visible",
    firstVisible: Number.isFinite(lod.firstVisible),
    coverage: lod.tiles > 0 && lod.cut?.length > 0,
    pending: state.pending === 0 && lod.pending === 0,
    activeKind: lod.activeKind === null,
    queuedUpload: lod.queuedUpload === false,
    preparations: lod.preparations === 0,
    gpuPending: lod.gpuPending === 0,
    retiringBytes: lod.retiringBytes === 0,
    renderPending: state.renderPending === false,
    recovering: state.lodRecovering === false,
    submissions:
      Number.isSafeInteger(lod.gpuProgress?.submittedSerial) &&
      lod.gpuProgress.submittedSerial > 0 &&
      lod.gpuProgress.completedSerial === lod.gpuProgress.submittedSerial &&
      lod.gpuProgress.oldestInFlightAgeMs === 0,
    jobs:
      Array.isArray(lod.memory?.entries) &&
      !lod.memory.entries.some((entry) =>
        ["job", "catalog-job", "resize"].includes(entry.id),
      ),
  })
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
}

export function checkMemory(state) {
  const { memory, logicalOccupancy } = state.lod;
  assert.ok(Number.isSafeInteger(memory.limitBytes) && memory.limitBytes > 0);
  assert.ok(memory.limitBytes <= CEILING, "Configured budget exceeds ceiling");
  for (const [name, bytes] of Object.entries({
    app: state.memory,
    total: memory.totalBytes,
    peak: memory.peakBytes,
    capacity: memory.capacityBytes,
    reserved: memory.reservedBytes,
    free: memory.freeBytes,
  })) {
    assert.ok(
      Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= memory.limitBytes,
      `${name} memory is outside budget`,
    );
  }
  assert.equal(state.memory, memory.totalBytes);
  assert.ok(memory.peakBytes >= memory.totalBytes);
  assert.equal(memory.freeBytes + memory.totalBytes, memory.limitBytes);
  assert.equal(memory.capacityBytes + memory.reservedBytes, memory.totalBytes);
  assert.equal(
    new Set(memory.entries.map((e) => e.id)).size,
    memory.entries.length,
  );
  assert.equal(
    memory.entries.reduce((sum, e) => sum + e.totalBytes, 0),
    memory.totalBytes,
  );
  assert.equal(
    Object.values(memory.categories).reduce((sum, bytes) => sum + bytes, 0),
    memory.totalBytes,
  );
  for (const entry of memory.entries) {
    for (const bytes of [
      entry.capacityBytes,
      entry.reservedBytes,
      entry.totalBytes,
    ])
      assert.ok(Number.isSafeInteger(bytes) && bytes >= 0);
    assert.equal(entry.capacityBytes + entry.reservedBytes, entry.totalBytes);
    assert.ok(Object.hasOwn(memory.categories, entry.category));
  }
  for (const [category, bytes] of Object.entries(memory.categories))
    assert.equal(
      bytes,
      memory.entries
        .filter((e) => e.category === category)
        .reduce((sum, e) => sum + e.totalBytes, 0),
    );
  assert.equal(logicalOccupancy.pickingBytes, state.lod.tiles * 131072);
  assert.ok(
    Number.isSafeInteger(logicalOccupancy.chunkIndexBytes) &&
      logicalOccupancy.chunkIndexBytes >= 0 &&
      logicalOccupancy.chunkIndexBytes <= state.lod.tiles * 2048,
    "Invalid resident chunk-index occupancy",
  );
  assert.equal(
    logicalOccupancy.pickingBytes + logicalOccupancy.chunkIndexBytes,
    memory.entries
      .filter((e) => e.id.startsWith("pick:"))
      .reduce((sum, e) => sum + e.capacityBytes, 0),
  );
  assert.ok(
    logicalOccupancy.surfaceBytes >= 0 &&
      logicalOccupancy.surfaceBytes <= memory.categories.surface,
  );
  assert.equal(logicalOccupancy.heightSlots, state.lod.heights);
  assert.ok(
    logicalOccupancy.heightSlots <= logicalOccupancy.heightSlotCapacity,
  );
}

export function checkReleased(fine, coarse) {
  assert.equal(fine.lod.level, 0);
  assert.ok(fine.lod.cut.every((id) => id.startsWith("0/")));
  assert.ok(fine.lod.catalogPages > 0 && fine.lod.materialDescriptors > 0);
  const exact = fine.lod.memory.entries.filter((e) =>
    e.id.startsWith("pick:0/"),
  );
  assert.ok(exact.length > 0, "Fine view never acquired exact picking data");
  assert.ok(coarse.lod.level > 0);
  assert.ok(
    coarse.lod.tiles < fine.lod.tiles,
    "Coarsening did not reduce resident tiles",
  );
  assert.ok(
    coarse.lod.memory.totalBytes < fine.lod.memory.totalBytes,
    "Coarsening did not release charged memory",
  );
  assert.equal(coarse.lod.catalogPages, 0);
  assert.equal(coarse.lod.materialDescriptors, 0);
  for (const id of [
    ...coarse.lod.cut,
    ...coarse.lod.previousCut,
    ...coarse.lod.heightKeys,
    ...coarse.lod.edgeSources,
  ])
    assert.ok(!id.startsWith("0/"), `Exact source still retained: ${id}`);
  for (const entry of coarse.lod.memory.entries)
    assert.ok(
      !/^(pick:0\/|catalog:)/.test(entry.id),
      `Exact detail still charged: ${entry.id}`,
    );
}

export function screenshotStats(png, geometry) {
  // Inspect only the central canvas: browser chrome, labels and tool icons cannot pass this gate.
  const { rect, width, height } = geometry;
  const sx = png.width / width,
    sy = png.height / height;
  assert.ok(Math.abs(sx - sy) < 0.02, "Screenshot/viewport aspect mismatch");
  assert.ok(rect.width > 0 && rect.height > 0 && rect.x >= 0 && rect.y >= 0);
  assert.ok(
    rect.x + rect.width <= width + 1 && rect.y + rect.height <= height + 1,
  );
  const x0 = Math.ceil((rect.x + rect.width * 0.15) * sx);
  const y0 = Math.ceil((rect.y + rect.height * 0.15) * sy);
  const x1 = Math.floor((rect.x + rect.width * 0.85) * sx);
  const y1 = Math.floor((rect.y + rect.height * 0.85) * sy);
  const colors = new Set(),
    quantizedColors = new Set();
  let colored = 0,
    samples = 0;
  const step = Math.max(1, Math.ceil(Math.max(x1 - x0, y1 - y0) / 400));
  for (let y = y0; y < y1; y += step)
    for (let x = x0; x < x1; x += step) {
      const i = (y * png.width + x) * 4;
      const rgb = [...png.data.subarray(i, i + 3)];
      colors.add(rgb.join(","));
      quantizedColors.add(rgb.map((value) => value >> 3).join(","));
      if (Math.max(...rgb) - Math.min(...rgb) > 24) colored++;
      samples++;
    }
  return {
    colors: colors.size,
    quantizedColors: quantizedColors.size,
    colored,
    samples,
    width: png.width,
    height: png.height,
  };
}

export function checkNonblank(stats) {
  assert.ok(
    stats.colors > 20,
    `Blank terrain: only ${stats.colors} canvas colors`,
  );
  assert.ok(stats.colored > 20, "Terrain has no colored canvas samples");
}

function summary(state) {
  if (!state) return null;
  const lod = state.lod;
  return {
    ...camera(state),
    ready: state.ready,
    visibility: state.visibility,
    draws: state.draws,
    failures: state.failures,
    message: state.message,
    renderPending: state.renderPending,
    lodRecoveries: state.lodRecoveries,
    lod: lod && {
      level: lod.level,
      targetLevel: lod.targetLevel,
      tiles: lod.tiles,
      heights: lod.heights,
      pending: lod.pending,
      activeKind: lod.activeKind,
      queuedUpload: lod.queuedUpload,
      preparations: lod.preparations,
      gpuPending: lod.gpuPending,
      gpuProgress: lod.gpuProgress,
      retiringBytes: lod.retiringBytes,
      firstVisible: lod.firstVisible,
      failures: lod.failures,
      memory: {
        totalBytes: lod.memory.totalBytes,
        peakBytes: lod.memory.peakBytes,
        limitBytes: lod.memory.limitBytes,
        entries: lod.memory.entries.length,
      },
    },
  };
}

async function main() {
  const config = verificationConfig({ output: ".local/lod-safari" });
  const target = new URL(config.url);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) ||
    !target.searchParams.has("lod") ||
    target.searchParams.get("players") !== "off"
  )
    throw Error("Use a loopback synthetic ?lod=... URL with players=off");
  const report = {
    target: target.href,
    webdriver: config.webdriver,
    scope:
      "Actual desktop Safari; frozen synthetic LOD only. No FPS, live-feed or iPad acceptance.",
    errorCapture:
      "Application failures/recoveries plus window errors, rejections and console errors after navigation.",
    gates: [],
    samples: [],
    stages: [],
    screenshots: [],
    errors: [],
  };
  await mkdir(config.output, { recursive: true });
  let root,
    activeGate = "availability",
    lastState;
  async function command(path, body, method = body ? "POST" : "GET") {
    const response = await fetch(config.webdriver + path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const { value } = await response.json();
    if (!response.ok || value?.error) throw Error(JSON.stringify(value));
    return value;
  }
  const run = (script) => command(`${root}/execute/sync`, { script, args: [] });
  async function gate(name, operation) {
    activeGate = name;
    const result = await operation();
    report.gates.push({ name, status: "passed" });
    console.log(`PASS ${name}`);
    return result;
  }
  async function sample() {
    lastState = await run(`return {
      failures: [], lodRecoveries: 0, ...window.__map?.state(),
      ready: window.__map?.ready === true,
      visibility: document.visibilityState,
      message: document.querySelector('#message-text')?.textContent,
      retry: document.querySelector('#retry')?.hidden === false,
      browserErrors: window.__lodSafariErrors
    }`);
    checkFailures(lastState);
    if (lastState.lod) checkMemory(lastState);
    return lastState;
  }
  async function settle(stage, expected = () => true) {
    const deadline = Date.now() + 60_000;
    let problems;
    while (Date.now() < deadline) {
      const state = await sample();
      problems = settledProblems(state);
      if (!problems.length && expected(state)) {
        report.stages.push({ stage, state });
        return state;
      }
      report.samples.push({ stage, state: summary(state), problems });
      if (report.samples.length > 120) report.samples.shift();
      await delay(500);
    }
    throw Error(
      `Safari LOD ${stage} did not settle: ${problems.join(", ")}; ${JSON.stringify(summary(lastState))}`,
    );
  }
  async function quiet(stage, before) {
    await delay(1000);
    const after = await sample();
    assert.deepEqual(settledProblems(after), []);
    assert.equal(
      after.draws,
      before.draws,
      "Stationary terrain keeps redrawing",
    );
    assert.deepEqual(camera(after), camera(before));
    assert.deepEqual(after.lod.cut, before.lod.cut);
    assert.equal(after.lod.tileUploads, before.lod.tileUploads);
    report.stages.push({ stage, state: after, observationMs: 1000 });
  }
  const geometry = () =>
    run(`const r = document.querySelector('#map').getBoundingClientRect();
    return {rect: {x:r.x, y:r.y, width:r.width, height:r.height},
      width:innerWidth, height:innerHeight, canvasWidth:document.querySelector('#map').width,
      canvasHeight:document.querySelector('#map').height, dpr:devicePixelRatio}`);
  async function screenshot(name, verify = true) {
    const box = await geometry();
    const bytes = Buffer.from(await command(`${root}/screenshot`), "base64");
    assert.ok(
      bytes.length <= 16 * 1024 * 1024,
      "Screenshot exceeds evidence bound",
    );
    await writeFile(`${config.output}/${name}.png`, bytes);
    const stats = screenshotStats(PNG.sync.read(bytes), box);
    report.screenshots.push({ name, ...stats, geometry: box });
    if (verify) checkNonblank(stats);
  }
  async function picking(stage, state, fine) {
    const { rect } = await geometry();
    const x = Math.round(rect.x + rect.width / 2 + 17);
    const y = Math.round(rect.y + rect.height / 2 - 13);
    await command(`${root}/actions`, {
      actions: [
        {
          type: "pointer",
          id: "mouse",
          parameters: { pointerType: "mouse" },
          actions: [
            // Repeated checks can reuse coordinates; force a real hover event after zoom/resize.
            {
              type: "pointerMove",
              duration: 0,
              origin: "viewport",
              x: x - 9,
              y: y - 7,
            },
            { type: "pointerMove", duration: 0, origin: "viewport", x, y },
          ],
        },
      ],
    });
    const picked = await run(`return {
      visible: !document.querySelector('#inspect').hidden,
      name: document.querySelector('#block-name').textContent,
      position: document.querySelector('#block-pos').textContent,
      detail: document.querySelector('#block-detail').textContent
    }`);
    assert.equal(picked.visible, true, "Surface picking is hidden");
    const [wx, height, wz] = picked.position.split(" / ").map(Number);
    assert.equal(
      wx,
      Math.floor(state.cx + (x - rect.x - rect.width / 2) / state.scale),
    );
    assert.equal(
      wz,
      Math.floor(state.cz + (y - rect.y - rect.height / 2) / state.scale),
    );
    assert.ok(Number.isFinite(height));
    assert.ok(picked.name && picked.name !== "Unresolved material");
    assert.equal(picked.name === "Surface summary", !fine);
    if (!fine) assert.match(picked.detail, /Approximate.*blocks per sample/);
    report.stages.push({ stage, picking: picked, pointer: { x, y } });
  }
  try {
    await gate("availability", async () => {
      assert.equal((await command("/status")).ready, true);
      const response = await fetch(target, {
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, 200, "Frozen preview unavailable");
      await response.body?.cancel();
    });
    activeGate = "session-navigation-error-capture";
    const session = await command("/session", {
      capabilities: { alwaysMatch: { browserName: "safari" } },
    });
    root = `/session/${session.sessionId}`;
    report.capabilities = session.capabilities;
    await command(`${root}/window/rect`, {
      x: 0,
      y: 0,
      width: 1920,
      height: 1176,
    });
    await command(`${root}/url`, { url: target.href });
    await run(`window.__lodSafariErrors = [];
      const record = (kind, value) => {
        if (window.__lodSafariErrors.length < 20)
          window.__lodSafariErrors.push({kind, message:String(value).slice(0, 1000)});
      };
      addEventListener('error', e => record('error', e.message));
      addEventListener('unhandledrejection', e => record('rejection', e.reason));
      const original = console.error;
      console.error = (...args) => { record('console', args.join(' ')); original.apply(console, args); };`);
    report.gates.push({ name: activeGate, status: "passed" });
    console.log(`PASS ${activeGate}`);
    await gate("fit-settled-memory-no-failures", () => settle("fit"));
    const setScale = (scale) =>
      run(`window.__map.zoom(${scale}/window.__map.state().scale)`);
    await setScale(0.12);
    const coarse = await gate("coarse-settled-memory-no-failures", () =>
      settle("coarse", (s) => s.lod.level > 0),
    );
    near(coarse.scale, 0.12);
    await gate("coarse-nonblank", () => screenshot("coarse"));
    await gate("coarse-stationary", () => quiet("coarse-quiet", coarse));
    await setScale(6);
    const fine = await gate("fine-settled-memory-no-failures", () =>
      settle("fine", (s) => s.lod.level === 0),
    );
    near(fine.scale, 6);
    await gate("fine-nonblank", () => screenshot("fine"));
    await gate("fine-picking-alignment", () =>
      picking("fine-pick", fine, true),
    );
    await gate("fine-stationary", () => quiet("fine-quiet", fine));
    const sun = await gate("sunlight-preserves-camera", async () => {
      await run(`document.querySelector('#lighting-toggle').click();
        const input = document.querySelector('#elevation');
        input.value = '15'; input.dispatchEvent(new Event('input', {bubbles:true}));
        document.querySelector('#azimuth').dispatchEvent(new KeyboardEvent('keydown', {key:'End', bubbles:true}));
        document.querySelector('#lighting-toggle').click();`);
      const state = await settle("sunlight", (s) => s.lod.level === 0);
      assert.deepEqual(camera(state), camera(fine));
      assert.equal(state.elevation, 15);
      assert.equal(state.azimuth, 359);
      assert.ok(state.draws > fine.draws, "Sunlight change did not draw");
      return state;
    });
    await gate("sunlight-nonblank", () => screenshot("sunlight"));
    await gate("sunlight-stationary", () => quiet("sunlight-quiet", sun));
    const oldBox = await geometry();
    const resized = await gate(
      "resize-preserves-camera-and-canvas",
      async () => {
        await command(`${root}/window/rect`, { width: 1100, height: 820 });
        const state = await settle("resize", (s) => s.draws > sun.draws);
        const box = await geometry();
        assert.notEqual(box.rect.width, oldBox.rect.width);
        assert.notEqual(box.rect.height, oldBox.rect.height);
        const dpr = Math.min(
          box.dpr,
          2,
          Math.sqrt(12_000_000 / (box.rect.width * box.rect.height * 4)),
        );
        near(box.canvasWidth, Math.floor(box.rect.width * dpr));
        near(box.canvasHeight, Math.floor(box.rect.height * dpr));
        assert.deepEqual(camera(state), camera(sun));
        return state;
      },
    );
    await gate("resized-picking-alignment", () =>
      picking("resize-pick", resized, true),
    );
    const moved = await gate("pointer-navigation-alignment", async () => {
      const { rect } = await geometry();
      const x = Math.round(rect.x + rect.width / 2),
        y = Math.round(rect.y + rect.height / 2);
      await command(`${root}/actions`, {
        actions: [
          {
            type: "pointer",
            id: "mouse",
            parameters: { pointerType: "mouse" },
            actions: [
              { type: "pointerMove", duration: 0, origin: "viewport", x, y },
              { type: "pointerDown", button: 0 },
              {
                type: "pointerMove",
                duration: 250,
                origin: "viewport",
                x: x + 60,
                y: y + 36,
              },
              { type: "pointerUp", button: 0 },
            ],
          },
        ],
      });
      const state = await settle("navigation", (s) => s.draws > resized.draws);
      near(state.cx, resized.cx - 60 / resized.scale);
      near(state.cz, resized.cz - 36 / resized.scale);
      near(state.scale, resized.scale);
      assert.equal(state.elevation, sun.elevation);
      assert.equal(state.azimuth, sun.azimuth);
      return state;
    });
    await gate("navigated-picking-alignment", () =>
      picking("navigation-pick", moved, true),
    );
    await gate("resized-navigation-nonblank", () =>
      screenshot("resized-navigation"),
    );
    await gate("navigation-stationary", () => quiet("navigation-quiet", moved));
    await setScale(0.12);
    const returned = await gate(
      "returned-coarse-settled-memory-no-failures",
      () => settle("returned-coarse", (s) => s.lod.level > 0),
    );
    await gate("coarse-fine-coarse-releases-exact-detail", () =>
      checkReleased(moved, returned),
    );
    await gate("returned-coarse-picking-alignment", () =>
      picking("returned-coarse-pick", returned, false),
    );
    await gate("returned-coarse-nonblank", () => screenshot("returned-coarse"));
    await gate("returned-coarse-stationary", () =>
      quiet("returned-coarse-quiet", returned),
    );
  } catch (error) {
    report.gates.push({
      name: activeGate,
      status: "failed",
      error: String(error),
    });
    report.errors.push(String(error));
    report.failureState = lastState;
    console.error(`FAIL ${activeGate}: ${error}`);
    if (root)
      await screenshot("failure", false).catch((e) =>
        report.errors.push(`Failure screenshot: ${e}`),
      );
    process.exitCode = 1;
  } finally {
    if (root)
      await command(root, undefined, "DELETE").catch((e) => {
        report.errors.push(`Session cleanup: ${e}`);
        process.exitCode = 1;
      });
    let json = JSON.stringify(report, null, 2) + "\n";
    if (Buffer.byteLength(json) > 2 * 1024 * 1024) {
      report.stages = report.stages.map(({ state, ...stage }) => ({
        ...stage,
        state: summary(state),
      }));
      report.failureState = summary(report.failureState);
      report.evidenceTruncated = true;
      json = JSON.stringify(report, null, 2) + "\n";
    }
    await writeFile(`${config.output}/report.json`, json);
    console.log(`Evidence: ${config.output}/report.json`);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await main();
