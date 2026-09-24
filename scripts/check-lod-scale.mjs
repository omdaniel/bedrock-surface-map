import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";
import { PNG } from "pngjs";
import { viewerUrl, aimView } from "./verification-config.mjs";
import {
  parseManifest,
  MAX_INDEX_BYTES,
  tileId,
} from "../web/src/lod/protocol.ts";

const { values } = parseArgs({
  options: {
    url: { type: "string", multiple: true },
    mode: { type: "string" },
    budget: { type: "string", default: "200000000" },
    seconds: { type: "string", default: "30" },
    output: { type: "string", default: ".local/lod-scale" },
    "simulate-objects": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  console.log(`Usage: node scripts/check-lod-scale.mjs --mode headful|headless \\
  --url 'http://127.0.0.1:5195/?lod=/maps/AVAILABLE-FIXTURE/lod.json&players=off' \\
  [--url ANOTHER_LOOPBACK_LOD_URL] [--budget 200000000|128000000] \\
  [--seconds 30] [--simulate-objects] [--output .local/lod-scale]

Requires installed Chrome and Node with direct TypeScript support (22.18+).
URLs and browser mode are required; no ambient MAP_URL, server launch, build,
fixture generation, viewer-config override, software GPU flags or profile changes.
--budget asserts the viewer's EXISTING configured budget; it does not set it.
--seconds is the minimum navigation window per URL (1..1200; 1200 = 20 min).
Always completes one fixed five-stage cycle; settling and final Fit add wall time.
--simulate-objects buffers same-origin objects, then delays fulfillment by 50 ms
plus their bytes at a shared 20,000,000 bit/s delivery budget. This is NOT real
network throughput, streaming, RTT, packet loss or a physical link measurement.
Screenshots and state polling perturb timing. No FPS/GPU timestamp claim is made.
Only supplied, available manifests are tested; declared extent is not population.
SIGINT/SIGTERM close Chrome. Each invocation writes a unique report directory.`);
} else {
  await main();
}

function target(raw) {
  const url = new URL(viewerUrl(raw));
  assert(
    url.hostname === "localhost" ||
      url.hostname === "[::1]" ||
      (isIP(url.hostname) === 4 && url.hostname.startsWith("127.")),
    "Loopback URLs only",
  );
  assert(
    !url.hash &&
      url.searchParams.getAll("lod").length === 1 &&
      url.searchParams.getAll("players").length === 1 &&
      url.searchParams.get("players") === "off" &&
      [...url.searchParams.keys()].every((key) =>
        ["lod", "players"].includes(key),
      ),
    "Use only ?lod=...&players=off, without a fragment",
  );
  const descriptor = new URL(url.searchParams.get("lod"), url);
  assert(
    descriptor.origin === url.origin &&
      !descriptor.username &&
      !descriptor.password &&
      !descriptor.search &&
      !descriptor.hash,
    "Manifest must be an uncredentialed same-origin URL",
  );
  return { url, descriptor };
}

async function manifestAt(descriptor) {
  const response = await fetch(descriptor, {
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  assert.equal(
    response.status,
    200,
    `Manifest HTTP ${response.status}; no scale result`,
  );
  const reader = response.body.getReader(),
    chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      assert(
        bytes <= MAX_INDEX_BYTES,
        "Manifest exceeds the protocol byte cap",
      );
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return parseManifest(
    JSON.parse(Buffer.concat(chunks).toString("utf8")),
    new URL(".", descriptor),
  );
}

function checkState(state, root, budget) {
  const lod = state?.lod,
    memory = lod?.memory;
  assert(memory, "LOD state unavailable");
  assert.equal(
    memory.limitBytes,
    budget,
    "Configure the requested budget externally before this run",
  );
  assert(
    memory.peakBytes <= budget &&
      memory.totalBytes <= budget &&
      memory.freeBytes >= 0,
    "Application-owned memory ceiling exceeded",
  );
  assert.equal(memory.capacityBytes + memory.reservedBytes, memory.totalBytes);
  assert.equal(
    memory.entries.reduce((sum, entry) => sum + entry.totalBytes, 0),
    memory.totalBytes,
  );
  assert.equal(
    Object.values(memory.categories).reduce((sum, bytes) => sum + bytes, 0),
    memory.totalBytes,
  );
  assert.equal(
    new Set(memory.entries.map((entry) => entry.id)).size,
    memory.entries.length,
  );
  assert(
    lod.indexes <= 512 &&
      lod.catalogPages <= root.catalog.length &&
      lod.materialDescriptors <= root.material_count,
    "Metadata/catalog residency cap exceeded",
  );
  assert(
    lod.logicalOccupancy.heightSlots <=
      lod.logicalOccupancy.heightSlotCapacity &&
      lod.logicalOccupancy.heightSlotCapacity <= 128,
    "Height page arena cap exceeded",
  );
  assert(
    lod.tiles <= Math.floor(budget / (524288 + 131072)),
    "Resident tile count exceeds even the minimum per-tile charge",
  );
  assert.equal(lod.logicalOccupancy.pickingBytes, lod.tiles * 131072);
  assert.deepEqual(lod.failures, [], "Application reported LOD failures");
  assert.equal(
    state.lodRecoveries,
    0,
    "Unexpected device recovery invalidates this scale run",
  );
}

function camera(s) {
  return {
    cx: s.cx,
    cz: s.cz,
    scale: s.scale,
    elevation: s.elevation,
    azimuth: s.azimuth,
  };
}
function sameCamera(actual, expected) {
  for (const key of Object.keys(expected))
    assert(
      Math.abs(actual[key] - expected[key]) < 1e-6,
      `Camera/lighting changed unexpectedly: ${key}`,
    );
}

async function settle(page) {
  // Account for the approved refinement debounce before accepting an idle snapshot.
  await delay(150);
  await page.waitForFunction(
    () => {
      const s = window.__map?.state(),
        l = s?.lod;
      return (
        window.__map?.ready &&
        l &&
        l.firstVisible !== null &&
        l.level === l.targetLevel &&
        l.pending === 0 &&
        l.activeKind === null &&
        !l.queuedUpload &&
        l.preparations === 0 &&
        l.gpuPending === 0 &&
        l.retiringBytes === 0 &&
        !s.renderPending &&
        !l.memory.entries.some(
          (entry) => entry.id === "job" || entry.id === "catalog-job",
        )
      );
    },
    undefined,
    { timeout: 90000 },
  );
  return page.evaluate(() => window.__map.state());
}

// Startup-only observation: stop as soon as coarse coverage or an ordering failure is seen.
function observeCold({ rootIds }) {
  const result = (window.__lodScaleCold = {
    done: false,
    state: null,
    rootIds,
    error: null,
  });
  const sample = () => {
    try {
      const s = window.__map?.state(),
        l = s?.lod;
      if (l) {
        const exact = l.memory.entries.some((entry) =>
          entry.id.startsWith("pick:0/"),
        );
        const roots = rootIds.every((id) => l.cut.includes(id));
        if (exact || (roots && l.firstVisible !== null)) {
          result.state = s;
          result.navigationObservedMs = performance.now();
          result.nativeFirstVisibleMs = l.firstVisible;
          result.timeOrigin = performance.timeOrigin;
          result.error = exact
            ? "Exact detail became resident before complete coarse root coverage was observed"
            : null;
          result.done = true;
          return;
        }
      }
      requestAnimationFrame(sample);
    } catch (error) {
      result.error = String(error);
      result.done = true;
    }
  };
  requestAnimationFrame(sample);
}

async function screenshot(page, directory, name) {
  const path = resolve(directory, `${name}.png`);
  const state = await page.evaluate(() => window.__map.state());
  const png = PNG.sync.read(await page.locator("#map").screenshot({ path }));
  const colors = new Map();
  // Exclude edge controls; retain actual full-resolution PNG evidence on disk.
  for (let y = Math.floor(png.height * 0.15); y < png.height * 0.85; y += 3)
    for (let x = Math.floor(png.width * 0.15); x < png.width * 0.85; x += 3) {
      const i = (y * png.width + x) * 4;
      const key = `${png.data[i] >> 3},${png.data[i + 1] >> 3},${png.data[i + 2] >> 3}`;
      colors.set(key, (colors.get(key) ?? 0) + 1);
    }
  const samples = [...colors.values()].reduce((a, b) => a + b, 0);
  const nonDominant = samples - Math.max(0, ...colors.values());
  return {
    path,
    state,
    width: png.width,
    height: png.height,
    colors: colors.size,
    nonDominantFraction: samples ? nonDominant / samples : 0,
    nonblank: colors.size >= 4 && nonDominant > samples * 0.01,
  };
}

async function instrument(context, target, report, signal) {
  const origin = target.url.origin,
    objectPrefix = new URL("objects/", target.descriptor).pathname;
  let deliveryEnd = 0;
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) {
      report.blockedCrossOrigin++;
      await route.abort("blockedbyclient");
    } else if (
      values["simulate-objects"] &&
      url.pathname.startsWith(objectPrefix)
    ) {
      let response;
      try {
        response = await route.fetch({ maxRedirects: 0, timeout: 30000 });
        const body = await response.body();
        assert(
          body.length <= 32 * 1024 * 1024,
          "Simulation object exceeds 32 MiB buffer cap",
        );
        deliveryEnd =
          Math.max(performance.now() + 50, deliveryEnd) +
          (body.length * 8) / 20000;
        await delay(Math.max(0, deliveryEnd - performance.now()), undefined, {
          signal,
        });
        await route.fulfill({ response, body });
        report.transfer.simulatedDeliveredBodyBytes += body.length;
      } catch (error) {
        if (
          !signal.aborted &&
          !/closed|abort|cancel|already handled/i.test(String(error)) &&
          report.errors.length < 50
        )
          report.errors.push(String(error));
        await route.abort().catch(() => {});
      } finally {
        await response?.dispose();
      }
    } else await route.continue();
  });
  await context.routeWebSocket(
    (url) => {
      const http = new URL(url);
      http.protocol = http.protocol === "ws:" ? "http:" : "https:";
      return http.origin !== origin;
    },
    async (socket) => {
      report.blockedCrossOrigin++;
      await socket.close({
        code: 1008,
        reason: "Loopback same-origin evidence only",
      });
    },
  );
  const pending = new Set();
  const local = (request) => new URL(request.url()).origin === origin;
  context.on("request", (request) => {
    if (local(request)) report.transfer.requests++;
  });
  context.on("requestfinished", (request) => {
    if (!local(request)) return;
    if (pending.size >= 64) {
      report.transfer.trackingOverflow++;
      return;
    }
    const work = request
      .sizes()
      .then((sizes) => {
        const bytes = sizes.responseBodySize + sizes.responseHeadersSize;
        report.transfer.encodedBytes += bytes;
        if (new URL(request.url()).pathname.startsWith(objectPrefix))
          report.transfer.objectEncodedBytes += bytes;
      })
      .catch(() => {
        report.transfer.sizeUnavailable++;
      });
    pending.add(work);
    void work.finally(() => pending.delete(work));
  });
  context.on("requestfailed", (request) => {
    if (!local(request)) return;
    if (/abort|cancel/i.test(request.failure()?.errorText ?? ""))
      report.transfer.canceled++;
    else report.transfer.failed++;
  });
  return async () => {
    while (pending.size) await Promise.all(pending);
  };
}

async function runDataset(
  browser,
  target,
  root,
  directory,
  budget,
  seconds,
  run,
  stopped,
) {
  const controller = new AbortController();
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1176 },
    deviceScaleFactor: 1,
    serviceWorkers: "block",
  });
  let page, flushTransfer;
  try {
    await context.addInitScript(observeCold, {
      rootIds: root.roots.map((ref) => tileId(ref.key)),
    });
    page = await context.newPage();
    flushTransfer = await instrument(context, target, run, controller.signal);
    const error = (message) => {
      if (run.errors.length < 50) run.errors.push(String(message));
    };
    page.on("pageerror", error);
    page.on("console", (message) => {
      if (message.type() === "error") error(message.text());
    });
    await page.goto(target.url.href, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.bringToFront();
    await page.waitForFunction(() => window.__lodScaleCold?.done, undefined, {
      timeout: 90000,
    });
    run.cold = await page.evaluate(() => window.__lodScaleCold);
    assert(!run.cold.error, run.cold.error);
    checkState(run.cold.state, root, budget);
    await flushTransfer();
    run.cold.transferAtCheckpoint = { ...run.transfer };
    run.screenshots.push(
      await screenshot(page, directory, "cold-fit-observed"),
    );
    // The PNG is a later observed frame, not a claim of synchronous first-visible capture.
    assert(
      run.screenshots.at(-1).nonblank,
      "Cold Fit PNG is blank or inconclusive; inspect it, no scale pass",
    );
    await page.evaluate(() => window.__map.fit());
    const fit = await settle(page);
    checkState(fit, root, budget);
    run.environment = await page.evaluate(() => {
      const canvas = document.querySelector("#map");
      return {
        userAgent: navigator.userAgent,
        visibility: document.visibilityState,
        dpr: devicePixelRatio,
        canvas: { width: canvas.width, height: canvas.height },
        main: { width: canvas.clientWidth, height: canvas.clientHeight },
      };
    });
    assert.equal(run.environment.dpr, 1);
    assert.equal(run.environment.canvas.width, 1920);
    assert.equal(run.environment.canvas.height, 1080);
    if (values.mode === "headful")
      assert.equal(run.environment.visibility, "visible");
    const bounds = root.bounds;
    assert(
      Math.abs(fit.cx - (bounds[0] + bounds[2]) / 2) < 1e-6 &&
        Math.abs(fit.cz - (bounds[1] + bounds[3]) / 2) < 1e-6,
      "Fit World did not retain the dataset center",
    );
    assert(
      (bounds[2] - bounds[0]) * fit.scale <= run.environment.main.width + 1 &&
        (bounds[3] - bounds[1]) * fit.scale <= run.environment.main.height + 1,
      "Fit World clipped the declared dataset bounds",
    );
    const phases = [
      { name: "spawn-fine", x: root.spawn[0], z: root.spawn[2], scale: 6 },
      { name: "far-ne", x: bounds[2] - 64, z: bounds[1] + 64, scale: 6 },
      { name: "far-sw", x: bounds[0] + 64, z: bounds[3] - 64, scale: 6 },
      { name: "spawn-revisit", x: root.spawn[0], z: root.spawn[2], scale: 6 },
      { name: "fit", x: fit.cx, z: fit.cz, scale: fit.scale },
    ];
    const start = performance.now();
    for (
      let cycle = 0;
      cycle === 0 || performance.now() - start < seconds * 1000;
      cycle++
    ) {
      for (const phase of phases) {
        assert(!stopped(), "Interrupted");
        if (phase.name === "fit") await page.evaluate(() => window.__map.fit());
        else await aimView(page, { view: phase });
        const value = await settle(page);
        checkState(value, root, budget);
        await flushTransfer();
        sameCamera(value, {
          cx: phase.x,
          cz: phase.z,
          scale: phase.scale,
          elevation: fit.elevation,
          azimuth: fit.azimuth,
        });
        assert(
          value.lod.cut.length > 0,
          "No presented coverage at a fixture workload anchor",
        );
        if (run.checkpoints.length < 128)
          run.checkpoints.push({
            cycle,
            phase: phase.name,
            elapsedMs: performance.now() - start,
            transfer: { ...run.transfer },
            state: value,
          });
        else run.droppedCheckpoints++;
        run.completedPhases++;
        if (cycle === 0) {
          run.screenshots.push(await screenshot(page, directory, phase.name));
          assert(
            run.screenshots.at(-1).nonblank,
            `Blank/inconclusive ${phase.name} PNG; no scale pass`,
          );
        }
        await delay(500, undefined, { signal: controller.signal });
        const idle = await page.evaluate(() => window.__map.state());
        checkState(idle, root, budget);
        if (values.mode === "headful")
          assert(
            await page.evaluate(() => !document.hidden),
            "Headful Chrome became hidden",
          );
        sameCamera(idle, camera(value));
        assert(
          idle.draws === value.draws && !idle.renderPending,
          "Terrain frame loop did not stop after settling",
        );
        assert(
          !run.errors.length &&
            !run.blockedCrossOrigin &&
            !run.transfer.failed &&
            !run.transfer.trackingOverflow,
          "Browser/network evidence contains errors",
        );
      }
    }
    run.workloadElapsedMs = performance.now() - start;
    run.final = await page.evaluate(() => window.__map.state());
    run.peakBytes = Math.max(
      run.cold.state.lod.memory.peakBytes,
      run.final.lod.memory.peakBytes,
    );
    run.status = "passed";
  } catch (error) {
    run.status = stopped() ? "interrupted" : "failed";
    run.errors.push(String(error));
    run.final = await page
      ?.evaluate(() => window.__map?.state())
      .catch(() => null);
  } finally {
    controller.abort();
    await context.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
    await flushTransfer?.();
    await context.close();
  }
}

async function main() {
  assert(
    values.url?.length && values.url.length <= 8,
    "Supply one to eight explicit --url arguments",
  );
  assert(
    ["headful", "headless"].includes(values.mode),
    "Explicit --mode headful|headless is required",
  );
  const budget = Number(values.budget),
    seconds = Number(values.seconds);
  assert(
    [200000000, 128000000].includes(budget),
    "--budget must be 200000000 or 128000000",
  );
  assert(
    Number.isInteger(seconds) && seconds >= 1 && seconds <= 1200,
    "--seconds must be 1..1200",
  );
  const targets = values.url.map(target),
    output = resolve(
      values.output,
      new Date().toISOString().replaceAll(":", "-"),
    );
  const report = {
    schemaVersion: 1,
    mode: values.mode,
    budget,
    requestedWorkloadSeconds: seconds,
    method: {
      browser:
        "Installed Chrome; fresh context per supplied URL; no software GPU overrides",
      viewport: { width: 1920, height: 1176, dpr: 1 },
      cold: "Browser-context cold only; preflight may warm OS/server caches. Startup rAF probe records root cut before exact residency",
      network: values["simulate-objects"]
        ? "Buffered object-delivery simulation: 20,000,000 bit/s shared queue + 50 ms per object, fulfilled all at once; not streaming or a real link"
        : "Unthrottled same-origin delivery",
      transfer:
        "Playwright context request.sizes across page/worker requests: encoded response body plus headers. Canceled partial transfers and Node preflight excluded; unavailable sizes counted. Simulated delivered body bytes are separate, not claimed as wire bytes. Routing disables HTTP cache",
      decode: "Native decodeMs excludes fetch/queue wait",
      workload:
        "Fixed five-stage cycles; at least one full cycle; seconds is a minimum window excluding cold start/final teardown. Keep at most 128 full checkpoints plus final state; validate caps at every phase",
      limitations:
        "No FPS, GPU timestamp, physical display, population-count or larger-unavailable-fixture claim. PNG nonblank heuristic needs human review. Harness memory is not application memory",
    },
    runs: [],
    errors: [],
  };
  await mkdir(output, { recursive: true });
  let browser,
    interrupted = false;
  const stop = () => {
    interrupted = true;
    void browser?.close().catch(() => {});
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    for (const [index, value] of targets.entries()) {
      if (interrupted) break;
      const run = {
        url: value.url.href,
        status: "starting",
        errors: [],
        blockedCrossOrigin: 0,
        transfer: {
          requests: 0,
          encodedBytes: 0,
          objectEncodedBytes: 0,
          simulatedDeliveredBodyBytes: 0,
          canceled: 0,
          failed: 0,
          trackingOverflow: 0,
          sizeUnavailable: 0,
        },
        checkpoints: [],
        screenshots: [],
        droppedCheckpoints: 0,
        completedPhases: 0,
      };
      report.runs.push(run);
      try {
        const root = await manifestAt(value.descriptor);
        if (!root) {
          run.status = "unavailable";
          run.errors.push("Manifest HTTP 404; fixture absent, no scale result");
          console.log(`${index + 1}: fixture unavailable; no scale result`);
          continue;
        }
        assert(!interrupted, "Interrupted");
        assert(
          root.roots.every((ref) => ref.key.level > 0),
          "Coarse-first validation requires non-leaf roots",
        );
        run.dataset = {
          bounds: root.bounds,
          extentBlocks: [
            root.bounds[2] - root.bounds[0],
            root.bounds[3] - root.bounds[1],
          ],
          sourceSha256: root.source_sha256,
          generation: root.generation,
          roots: root.roots,
          materialCount: root.material_count,
          catalogPageCount: root.catalog.length,
          populatedColumns: null,
        };
        browser ??= await chromium.launch({
          channel: "chrome",
          headless: values.mode === "headless",
          handleSIGINT: false,
          handleSIGTERM: false,
        });
        report.chromeVersion = browser.version();
        const directory = resolve(output, String(index + 1));
        await mkdir(directory, { recursive: true });
        await runDataset(
          browser,
          value,
          root,
          directory,
          budget,
          seconds,
          run,
          () => interrupted,
        );
      } catch (error) {
        run.status = interrupted ? "interrupted" : "failed";
        run.errors.push(String(error));
      }
      console.log(
        `${index + 1}: ${run.status}; peak ${run.peakBytes ?? "unavailable"} bytes`,
      );
      if (run.status === "failed" || interrupted) break;
    }
  } finally {
    try {
      await browser?.close();
    } catch (error) {
      report.errors.push(`Chrome cleanup failed: ${error}`);
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      report.status = interrupted
        ? "interrupted"
        : !report.errors.length &&
            report.runs.length === targets.length &&
            report.runs.every((run) => run.status === "passed")
          ? "passed"
          : "incomplete";
      const origins = new Set(targets.map((value) => value.url.origin));
      const json = JSON.stringify(
        report,
        (key, value) =>
          typeof value === "string" && key !== "url"
            ? value.replace(/(?:https?|wss?):\/\/[^\s"'<>]+/g, (raw) => {
                try {
                  const url = new URL(raw);
                  return origins.has(url.origin)
                    ? url.origin + url.pathname
                    : "[external URL omitted]";
                } catch {
                  return "[URL omitted]";
                }
              })
            : value,
        2,
      );
      await writeFile(resolve(output, "report.json"), json + "\n");
      console.log(
        `LOD scale ${report.status}: ${resolve(output, "report.json")}`,
      );
      if (report.status !== "passed") process.exitCode = 1;
    }
  }
}
