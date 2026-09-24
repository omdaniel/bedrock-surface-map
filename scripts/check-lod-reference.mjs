import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { aimView, viewerUrl, waitForMap } from "./verification-config.mjs";

const { values } = parseArgs({
  options: {
    "baseline-url": { type: "string" },
    "candidate-url": { type: "string" },
    output: { type: "string", default: ".local/lod-reference" },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  console.log(`Usage: node scripts/check-lod-reference.mjs \\
  --baseline-url 'http://127.0.0.1:5196/?map=/maps/lod-fixture/source/manifest.json&players=off' \\
  --candidate-url 'http://127.0.0.1:5195/?lod=/maps/lod-fixture/lod.json&players=off' \\
  [--output .local/lod-reference]

Run only after both servers and renderers are ready. Installed headful Chrome;
first a 10-second blank-page rAF calibration, then fresh contexts in
baseline/candidate/candidate/baseline order; identical 1024x1024
fixture, camera (64,64), scale 6, viewport 1920x1176 and DPR 1. Each run has one
5-second pan warmup and a 10-second measured pan capped at 60 inputs/second.
No video or screenshots. Input cadence does not set physical display refresh;
independent rAF histograms report the cadence Chrome actually delivers.`);
} else {
  await main();
}

function target(raw, kind) {
  if (!raw)
    throw Error(
      `--${kind}-url is required; ambient MAP_URL/configuration is not used`,
    );
  const url = new URL(viewerUrl(raw));
  const local =
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    (isIP(url.hostname) === 4 && url.hostname.startsWith("127."));
  const parameter = kind === "baseline" ? "map" : "lod";
  const other = kind === "baseline" ? "lod" : "map";
  const descriptor = url.searchParams.get(parameter);
  if (
    !local ||
    url.hash ||
    !descriptor ||
    url.searchParams.has(other) ||
    url.searchParams.get("players") !== "off"
  )
    throw Error(
      `${kind} requires an explicit loopback URL with ${parameter}=... and players=off`,
    );
  if (
    [...url.searchParams.keys()].some(
      (key) => ![parameter, "players"].includes(key),
    ) ||
    url.searchParams.getAll(parameter).length !== 1 ||
    url.searchParams.getAll("players").length !== 1
  )
    throw Error(
      `${kind} URL must contain only one ${parameter} parameter and players=off for this matched diagnostic`,
    );
  const data = new URL(descriptor, url);
  if (
    data.origin !== url.origin ||
    data.username ||
    data.password ||
    data.search ||
    data.hash
  )
    throw Error(
      `${kind} descriptor must be an uncredentialed same-origin fixture URL`,
    );
  return { url, data };
}

async function fixture(context, data) {
  const response = await context.request.get(data.href, {
    maxRedirects: 0,
    timeout: 15_000,
  });
  if (response.status() !== 200)
    throw Error(`Fixture descriptor HTTP ${response.status()}`);
  const bytes = await response.body();
  if (bytes.length > 2 * 1024 * 1024)
    throw Error("Fixture descriptor exceeds 2 MiB");
  const value = JSON.parse(bytes.toString("utf8"));
  const b = value.bounds;
  if (
    !Array.isArray(b) ||
    b.length !== 4 ||
    !b.every(Number.isSafeInteger) ||
    b[2] - b[0] !== 1024 ||
    b[3] - b[1] !== 1024 ||
    !(b[0] <= 64 && b[1] <= 64 && b[2] > 64 && b[3] > 64) ||
    typeof value.source_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.source_sha256)
  )
    throw Error(
      "Expected the 1024x1024 synthetic fixture containing (64,64), with a SHA-256 source fingerprint",
    );
  return { bounds: b, sourceSha256: value.source_sha256 };
}

function withDeadline(promise, milliseconds, label = "Pan measurement") {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () =>
          reject(Error(`${label} timed out; Chrome may be hidden or stalled`)),
        milliseconds,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

async function main() {
  const targets = {
    baseline: target(values["baseline-url"], "baseline"),
    candidate: target(values["candidate-url"], "candidate"),
  };
  const origins = new Set(Object.values(targets).map(({ url }) => url.origin));
  const redact = (value) =>
    String(value)
      .replace(/(?:https?|wss?):\/\/[^\s"'<>]+/g, (raw) => {
        try {
          const url = new URL(raw);
          if (url.protocol === "ws:") url.protocol = "http:";
          if (url.protocol === "wss:") url.protocol = "https:";
          return origins.has(url.origin)
            ? url.origin + url.pathname
            : "[external URL omitted]";
        } catch {
          return "[URL omitted]";
        }
      })
      .slice(0, 4096);
  const output = resolve(
    values.output,
    new Date().toISOString().replaceAll(":", "-"),
  );
  await mkdir(output, { recursive: true });
  const report = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    status: "running",
    baselineUrl: targets.baseline.url.href,
    candidateUrl: targets.candidate.url.href,
    method: {
      order: ["baseline", "candidate", "candidate", "baseline"],
      freshContextPerRun: true,
      camera: { cx: 64, cz: 64, scale: 6 },
      viewport: { width: 1920, height: 1176 },
      dpr: 1,
      physicalMapTarget: { width: 1920, height: 1080 },
      blankPageCalibration:
        "Before ABBA: 10 seconds on visible about:blank in a fresh context; only rAF timestamps and visibility checks, no app, observers, routes, media capture or protocol polling during timing",
      candidateReadiness:
        "After aim: current and target LOD 0, nonempty cut, pending=0, activeKind=null, queuedUpload=false, preparations=0 and no pending render",
      warmupSeconds: 5,
      measuredSeconds: 10,
      panInputCapHz: 60,
      path: "x=64+12*sin(t/700), z=64+7.2*sin(t/1100), milliseconds; restart at center after warmup",
      timing:
        "Independent real rAF intervals; submitted FPS uses __map.state().draws over the measured pan only. No GPU timestamps",
      instrumentation:
        "No video, screenshots or periodic protocol polling during timing; one in-page rAF loop and a bounded long-task observer",
      network:
        "Same-origin fixture traffic only. Identical cross-origin security routes disable HTTP cache for both versions; service workers blocked",
      display:
        "60 inputs/second is a workload cap, not a physical 60 Hz display configuration. Report observed input and rAF cadence separately",
    },
    runs: [],
    errors: [],
  };
  let browser, currentContext, reference;
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
    void currentContext?.close().catch(() => {});
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    browser = await chromium.launch({
      channel: "chrome",
      headless: false,
      handleSIGINT: false,
      handleSIGTERM: false,
    });
    report.chromeVersion = browser.version();
    report.blankPageCalibration = { status: "running", url: "about:blank" };
    try {
      currentContext = await browser.newContext({
        viewport: report.method.viewport,
        deviceScaleFactor: 1,
        serviceWorkers: "block",
      });
      const page = await currentContext.newPage();
      await page.bringToFront();
      const result = await withDeadline(
        page.evaluate(calibrateRaf),
        25_000,
        "Blank-page rAF calibration",
      );
      report.blankPageCalibration.measurement = result;
      report.blankPageCalibration.summary = summarizeRaf(result);
      if (result.error) throw Error(result.error);
      report.blankPageCalibration.status = "completed";
      console.log(
        `Blank-page calibration: rAF ${report.blankPageCalibration.summary.rafHz?.toFixed(2)} Hz; p95 ${report.blankPageCalibration.summary.p95Ms?.toFixed(3)} ms`,
      );
    } catch (error) {
      report.blankPageCalibration.status = interrupted
        ? "interrupted"
        : "failed";
      report.blankPageCalibration.error = redact(error);
      throw error;
    } finally {
      await currentContext?.close();
      currentContext = undefined;
    }
    for (const [index, kind] of report.method.order.entries()) {
      if (interrupted) break;
      const { url, data } = targets[kind];
      const run = {
        sequence: index + 1,
        kind,
        status: "starting",
        errors: [],
        blockedCrossOrigin: 0,
      };
      report.runs.push(run);
      const error = (value) => {
        if (run.errors.length < 50) run.errors.push(redact(value));
        else run.droppedErrors = (run.droppedErrors ?? 0) + 1;
      };
      try {
        currentContext = await browser.newContext({
          viewport: report.method.viewport,
          deviceScaleFactor: 1,
          serviceWorkers: "block",
        });
        await currentContext.route(
          (request) => request.origin !== url.origin,
          async (route) => {
            run.blockedCrossOrigin++;
            await route.abort("blockedbyclient");
          },
        );
        await currentContext.routeWebSocket(
          (socket) => {
            const http = new URL(socket);
            http.protocol = http.protocol === "ws:" ? "http:" : "https:";
            return http.origin !== url.origin;
          },
          async (socket) => {
            run.blockedCrossOrigin++;
            await socket.close({
              code: 1008,
              reason: "Matched diagnostic is same-origin only",
            });
          },
        );
        run.fixture = await fixture(currentContext, data);
        reference ??= run.fixture;
        if (JSON.stringify(run.fixture) !== JSON.stringify(reference))
          throw Error(
            "Baseline and candidate fixture bounds/source fingerprint differ",
          );
        const page = await currentContext.newPage();
        page.on("pageerror", error);
        page.on("console", (message) => {
          if (message.type() === "error") error(message.text());
        });
        await page.goto(url.href, {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });
        await page.bringToFront();
        await waitForMap(page, { expectedRegions: null });
        await aimView(page, { view: { x: 64, z: 64, scale: 6 } });
        if (kind === "candidate") {
          try {
            // Generic map readiness can precede the refinement debounce and GPU preparation.
            await page.waitForFunction(
              () => {
                const state = window.__map?.state();
                const lod = state?.lod;
                return (
                  lod?.level === 0 &&
                  lod.targetLevel === 0 &&
                  lod.cut.length > 0 &&
                  state.pending === 0 &&
                  lod.pending === 0 &&
                  lod.activeKind === null &&
                  lod.queuedUpload === false &&
                  lod.preparations === 0 &&
                  !state.renderPending
                );
              },
              null,
              { timeout: 90_000 },
            );
          } catch (error) {
            run.readinessState = await page.evaluate(() =>
              window.__map.state(),
            );
            throw Error(
              `Candidate did not settle at LOD 0 with no pending work, uploads or GPU preparations: ${error}`,
            );
          }
        }
        run.environment = await page.evaluate(() => {
          const canvas = document.querySelector("#map"),
            main = document.querySelector("main").getBoundingClientRect();
          return {
            userAgent: navigator.userAgent,
            visibility: document.visibilityState,
            dpr: devicePixelRatio,
            canvas: { width: canvas.width, height: canvas.height },
            main: { width: main.width, height: main.height },
          };
        });
        run.readyState = await page.evaluate(() => window.__map.state());
        if (
          run.environment.visibility !== "visible" ||
          run.environment.dpr !== 1 ||
          run.environment.canvas.width !== 1920 ||
          run.environment.canvas.height !== 1080
        )
          throw Error(
            "Matched run requires a visible 1920x1080 physical map at DPR 1",
          );
        if (
          kind === "candidate"
            ? !run.readyState.lod || run.readyState.lod.level !== 0
            : Boolean(run.readyState.lod)
        )
          throw Error(
            "Expected the legacy renderer for baseline and LOD level 0 for candidate",
          );
        if (
          Math.abs(run.readyState.cx - 64) > 1e-6 ||
          Math.abs(run.readyState.cz - 64) > 1e-6 ||
          Math.abs(run.readyState.scale - 6) > 1e-6
        )
          throw Error("Matched camera configuration was not applied");
        const result = await withDeadline(page.evaluate(measurePan), 35_000);
        if (result.error) throw Error(result.error);
        run.measurement = result;
        run.summary = summarize(result);
        if (result.endState.failures?.length)
          error(JSON.stringify(result.endState.failures));
        if (run.blockedCrossOrigin)
          error(
            `Blocked ${run.blockedCrossOrigin} cross-origin requests; matched input scope was not maintained`,
          );
        run.status =
          run.errors.length || run.blockedCrossOrigin ? "failed" : "completed";
        console.log(
          `${index + 1}/4 ${kind}: rAF ${run.summary.rafHz?.toFixed(2)} Hz; input ${run.summary.inputHz.toFixed(2)} Hz; submitted ${run.summary.submittedFps.toFixed(2)} FPS; p95 ${run.summary.p95Ms?.toFixed(3)} ms`,
        );
      } catch (failure) {
        run.status = interrupted ? "interrupted" : "failed";
        error(failure);
      } finally {
        try {
          await currentContext?.close();
        } catch (failure) {
          error(failure);
          run.status = "failed";
        }
        currentContext = undefined;
      }
    }
    report.status = interrupted
      ? "interrupted"
      : report.runs.every((run) => run.status === "completed")
        ? "completed"
        : "failed";
    report.comparison = {
      matched:
        report.runs.length === 4 &&
        report.runs.every((run) => run.status === "completed"),
      baseline: report.runs
        .filter((run) => run.kind === "baseline")
        .map((run) => run.summary ?? null),
      candidate: report.runs
        .filter((run) => run.kind === "candidate")
        .map((run) => run.summary ?? null),
      interpretation:
        "Compare blank-page rAF with both renderers to check for shared Chrome cadence limits. A shared 30 Hz cadence does not identify Energy Saver or any other cause. These counters do not identify a GPU bottleneck or establish the physical display refresh rate",
    };
  } catch (error) {
    report.status = interrupted ? "interrupted" : "failed";
    report.errors.push(redact(error));
  } finally {
    try {
      await currentContext?.close();
    } catch (error) {
      report.errors.push(redact(error));
    } finally {
      try {
        await browser?.close();
      } catch (error) {
        report.errors.push(redact(error));
      }
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
    }
    report.finishedAt = new Date().toISOString();
    if (report.errors.length) report.status = "failed";
    if (report.status !== "completed") process.exitCode = 1;
    // State snapshots may contain application error strings; keep evidence URL scope local.
    const json = JSON.stringify(
      report,
      (key, value) =>
        !["baselineUrl", "candidateUrl"].includes(key) &&
        typeof value === "string" &&
        value.includes("://")
          ? redact(value)
          : value,
      2,
    );
    await writeFile(resolve(output, "report.json"), json + "\n");
    console.log(
      `Matched LOD reference ${report.status}: ${resolve(output, "report.json")}`,
    );
  }
}

function summarizeRaf(result) {
  const sorted = [...result.frameIntervalsMs].sort((a, b) => a - b);
  const percentile = (p) =>
    sorted.length
      ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]
      : null;
  const bins = new Array(1001).fill(0);
  for (const interval of sorted)
    bins[Math.min(1000, Math.floor(interval / 0.25))]++;
  const p50 = percentile(0.5);
  return {
    elapsedMs: result.elapsedMs,
    rafIntervals: sorted.length,
    rafHz: p50 ? 1000 / p50 : null,
    averageRafHz: result.elapsedMs
      ? (sorted.length * 1000) / result.elapsedMs
      : null,
    p50Ms: p50,
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    maxMs: sorted.at(-1) ?? null,
    histogram: { binWidthMs: 0.25, overflowAtMs: 250, bins },
  };
}

function summarize(result) {
  return {
    ...summarizeRaf(result),
    inputHz: (result.panInputs * 1000) / result.elapsedMs,
    submittedFps: (result.submittedFrames * 1000) / result.elapsedMs,
    longTasks: result.longTasks,
  };
}

// Keep the calibration page empty; only collect callback timestamps and visibility.
function calibrateRaf() {
  return new Promise((resolve) => {
    const result = {
      elapsedMs: 0,
      timeOrigin: performance.timeOrigin,
      visibilityStart: document.visibilityState,
      visibilityEnd: null,
      frameIntervalsMs: [],
      error: null,
    };
    let started = null,
      previous = null;
    const frame = (now) => {
      started ??= now;
      result.elapsedMs = now - started;
      if (document.hidden) {
        result.error = "Chrome became hidden during blank-page rAF calibration";
      } else if (result.frameIntervalsMs.length >= 20_000) {
        result.error = "Blank-page frame interval evidence cap exceeded";
      } else if (previous !== null) {
        result.frameIntervalsMs.push(now - previous);
      }
      previous = now;
      if (result.error || result.elapsedMs >= 10_000) {
        result.visibilityEnd = document.visibilityState;
        resolve(result);
        return;
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

// All timing and pan commands stay inside one rAF loop, with no protocol polling.
function measurePan() {
  return new Promise((resolve) => {
    const result = {
      warmupMs: null,
      elapsedMs: 0,
      timeOrigin: performance.timeOrigin,
      panInputs: 0,
      frameIntervalsMs: [],
      submittedFrames: 0,
      longTasks: {
        supported: false,
        count: 0,
        totalMs: 0,
        maxMs: 0,
        records: [],
        droppedRecords: 0,
      },
      warmupState: window.__map.state(),
      startState: null,
      endState: null,
      error: null,
    };
    const started = performance.now();
    let measuredStart = null,
      previous = null,
      lastInput = null,
      raf = 0,
      finished = false;
    let lastX = result.warmupState.cx,
      lastZ = result.warmupState.cz;
    let observer;
    const tasks = (entries) => {
      for (const entry of entries) {
        if (measuredStart === null || entry.startTime < measuredStart) continue;
        const stats = result.longTasks;
        stats.count++;
        stats.totalMs += entry.duration;
        stats.maxMs = Math.max(stats.maxMs, entry.duration);
        if (stats.records.length < 128)
          stats.records.push({
            startMs: entry.startTime - measuredStart,
            durationMs: entry.duration,
          });
        else stats.droppedRecords++;
      }
    };
    const finish = (now, error = null) => {
      if (finished) return;
      finished = true;
      cancelAnimationFrame(raf);
      if (observer) {
        tasks(observer.takeRecords());
        observer.disconnect();
      }
      result.endState = window.__map.state();
      result.elapsedMs = measuredStart === null ? 0 : now - measuredStart;
      result.submittedFrames = result.startState
        ? result.endState.draws - result.startState.draws
        : 0;
      result.error = error;
      resolve(result);
    };
    if (PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
      result.longTasks.supported = true;
      observer = new PerformanceObserver((list) => tasks(list.getEntries()));
      observer.observe({ type: "longtask", buffered: false });
    }
    const frame = (now) => {
      try {
        if (document.hidden) {
          finish(now, "Chrome became hidden during the matched pan");
          return;
        }
        if (measuredStart === null && now - started >= 5000) {
          result.warmupMs = now - started;
          window.__map.pan(64 - lastX, 64 - lastZ);
          lastX = 64;
          lastZ = 64;
          lastInput = now;
          measuredStart = now;
          previous = null;
          result.startState = window.__map.state();
        }
        if (measuredStart !== null) {
          if (previous !== null) {
            if (result.frameIntervalsMs.length >= 20_000)
              throw Error("Frame interval evidence cap exceeded");
            result.frameIntervalsMs.push(now - previous);
          }
          previous = now;
          if (now - measuredStart >= 10_000) {
            finish(now);
            return;
          }
        }
        // Cap pan inputs only; every real rAF callback still contributes timing.
        if (lastInput === null || now - lastInput + 1e-6 >= 1000 / 60) {
          const elapsed = now - (measuredStart ?? started);
          const x = 64 + 12 * Math.sin(elapsed / 700),
            z = 64 + 7.2 * Math.sin(elapsed / 1100);
          window.__map.pan(x - lastX, z - lastZ);
          lastX = x;
          lastZ = z;
          lastInput = now;
          if (measuredStart !== null) result.panInputs++;
        }
        raf = requestAnimationFrame(frame);
      } catch (error) {
        finish(now, String(error));
      }
    };
    raf = requestAnimationFrame(frame);
  });
}
