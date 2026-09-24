import { chromium } from "@playwright/test";
import { PNG } from "pngjs";
import { mkdir, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { arch, platform, release } from "node:os";
import { basename, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    url: {
      type: "string",
      default:
        "http://127.0.0.1:5195/?lod=/maps/lod-fixture/lod.json&players=off",
    },
    output: { type: "string", default: ".local/lod-evidence" },
    seconds: { type: "string", default: "120" },
    video: { type: "boolean", default: false },
    hardware: { type: "string" },
    "display-hz": { type: "string" },
    "workload-hz": { type: "string" },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  console.log(`Usage: node scripts/check-lod.mjs [options]
  --url URL        Explicit loopback viewer (default port 5195, lod-fixture)
  --output DIR     Evidence parent directory (default .local/lod-evidence)
  --seconds N      Measured duration, 1..7200 seconds (default 120; 1200 = 20 min)
  --video          Record the run; video encoding can affect measured cadence
  --hardware TEXT  Optional operator-supplied machine description
  --display-hz N   Manually configured physical display rate, not a browser override
  --workload-hz N  Cap pan inputs per second (e.g. 60; default every rAF)

Workload Hz limits camera inputs only. It does not set the physical display rate
or throttle the independent rAF histogram. Submitted FPS is reported per phase.

Requires installed, headful Google Chrome and a ready native LOD fixture server.
Run only after the renderer/browser readiness gate. No server is started here.
No software GPU flags, GPU timestamps, display settings or production monitors.
Each run writes a unique subdirectory. SIGINT/SIGTERM stop and close Chrome.`);
} else {
  await main();
}

async function main() {
  // Do not inherit MAP_URL or operator configuration pointing at private services.
  const target = new URL(values.url);
  const loopback =
    target.hostname === "localhost" ||
    target.hostname === "[::1]" ||
    (isIP(target.hostname) === 4 && target.hostname.startsWith("127."));
  if (
    !loopback ||
    !["http:", "https:"].includes(target.protocol) ||
    target.username ||
    target.password ||
    target.hash
  )
    throw Error(
      "LOD evidence requires an explicit, uncredentialed loopback HTTP(S) URL",
    );
  const dataset = target.searchParams.get("lod");
  const datasetUrl = dataset ? new URL(dataset, target) : null;
  if (
    !datasetUrl ||
    datasetUrl.origin !== target.origin ||
    datasetUrl.username ||
    datasetUrl.password ||
    datasetUrl.search ||
    datasetUrl.hash ||
    target.searchParams.get("players") !== "off"
  )
    throw Error("Use a same-origin ?lod=... fixture and players=off");
  const seconds = Number(values.seconds);
  const displayHz =
    values["display-hz"] === undefined ? null : Number(values["display-hz"]);
  const workloadHz =
    values["workload-hz"] === undefined ? null : Number(values["workload-hz"]);
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 7200)
    throw Error("--seconds must be between 1 and 7200");
  if (
    displayHz !== null &&
    (!Number.isFinite(displayHz) || displayHz < 1 || displayHz > 1000)
  )
    throw Error(
      "--display-hz must be a manually configured rate between 1 and 1000",
    );
  if (
    workloadHz !== null &&
    (!Number.isFinite(workloadHz) || workloadHz < 1 || workloadHz > 1000)
  )
    throw Error("--workload-hz must be a pan-input cap between 1 and 1000");
  if (values.hardware && values.hardware.length > 512)
    throw Error("--hardware is limited to 512 characters");

  const runId = new Date().toISOString().replaceAll(":", "-");
  const output = resolve(values.output, runId);
  await mkdir(output, { recursive: true });
  const sameOrigin = (raw) => {
    try {
      return new URL(raw).origin === target.origin;
    } catch {
      return false;
    }
  };
  const cleanText = (value) =>
    String(value)
      .replace(/(?:https?|wss?):\/\/[^\s"'<>]+/g, (raw) => {
        try {
          const url = new URL(raw);
          if (url.protocol === "ws:") url.protocol = "http:";
          if (url.protocol === "wss:") url.protocol = "https:";
          return url.origin === target.origin
            ? url.origin + url.pathname
            : "[external URL omitted]";
        } catch {
          return "[URL omitted]";
        }
      })
      .slice(0, 2048);
  const report = {
    schemaVersion: 2,
    status: "starting",
    startedAt: new Date().toISOString(),
    target: target.href,
    requestedSeconds: seconds,
    workloadHz,
    method: {
      browser: "Installed Google Chrome, headful, no software GPU overrides",
      cycleSeconds: 30,
      phases:
        "coarse pan 4s; fine pan 9s; fast pan reversals 8s; returned coarse pan 5s; fit/rest 4s",
      camera:
        "Only __map.fit(), spawn(), zoom() and pan(); no private targets or map internals",
      workload:
        "Optional rAF-timestamp pan-input cap; no catch-up bursts. Phase-entry fit/spawn/zoom steps are separate. Input cadence does not set physical display refresh or rAF cadence",
      timing:
        "Independent rAF intervals on every callback; phase-boundary draw-counter deltas measure submitted FPS for each phase, not GPU completion",
      decode:
        "Application decodeMs counter measures native decoding only, excluding fetch and queue wait",
      instrumentation:
        "Temporary test context; bounded in-page histograms and 1 Hz snapshots; not included in the application's ledger",
      network:
        "Only same-origin records; cross-origin HTTP and WebSockets blocked. Playwright routing disables the browser HTTP cache",
      video: values.video,
      screenshotsPerturbTiming: true,
    },
    environment: {
      os: platform(),
      release: release(),
      architecture: arch(),
      hardware: values.hardware ? cleanText(values.hardware) : null,
      manuallyConfiguredDisplayHz: displayHz,
    },
    targets: {
      viewportCss: { width: 1920, height: 1176 },
      physicalMap: { width: 1920, height: 1080 },
      dpr: 1,
      applicationMemoryCeilingBytes: 200_000_000,
      refinementLevel: 0,
      coarseLevel: "> 0",
      nominal60HzFrameBudgetMs: 1000 / 60,
      panInputCapHz: workloadHz,
    },
    gpuTimestamps: {
      collected: false,
      supportedByQueriedAdapter: null,
      reason:
        "Renderer GPU timestamp instrumentation is not exposed; rAF timing is not GPU timing",
    },
    requests: {
      started: 0,
      finished: 0,
      failed: 0,
      active: 0,
      peakActive: 0,
      responseBytes: 0,
      sizeUnavailable: 0,
      blockedCrossOrigin: 0,
      statuses: {},
      records: [],
      droppedRecords: 0,
    },
    samples: [],
    screenshots: [],
    errors: [],
    droppedErrors: 0,
    limitations: [
      "No physical display refresh, monitor power, OS sleep/lock or GPU reset control is automated.",
      "A 60 Hz baseline is conditional on the operator setting the display to 60 Hz and declaring --display-hz 60; observed rAF cadence is reported independently.",
      "--workload-hz 60 caps pan inputs only. rAF quantization or slow frames may lower actual input cadence; this does not establish a physical 60 Hz display baseline.",
      "Timestamp-query availability does not mean GPU timing was collected. A separately queried adapter may differ from the renderer's selected adapter.",
      "Warm-cache production performance is not measured because the cross-origin safety route disables HTTP cache.",
    ],
  };
  let browser, context, page, video;
  let stopSignal = null;
  const stop = (signal) => {
    stopSignal = signal;
  };
  const onInterrupt = () => stop("SIGINT"),
    onTerminate = () => stop("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  const addError = (value) => {
    if (report.errors.length < 100) report.errors.push(cleanText(value));
    else report.droppedErrors++;
  };
  const metadata = new Set();
  let latestPhase = "startup";
  try {
    browser = await chromium.launch({
      channel: "chrome",
      headless: false,
      handleSIGINT: false,
      handleSIGTERM: false,
    });
    report.environment.chromeVersion = browser.version();
    try {
      const cdp = await browser.newBrowserCDPSession();
      const system = await cdp.send("SystemInfo.getInfo");
      report.environment.chromeGpuDevices = system.gpu.devices.map(
        (device) => ({
          vendorId: device.vendorId,
          deviceId: device.deviceId,
          vendorString: cleanText(device.vendorString),
          deviceString: cleanText(device.deviceString),
          driverVendor: device.driverVendor,
          driverVersion: device.driverVersion,
        }),
      );
      report.environment.gpuFeatureStatus = system.gpu.featureStatus;
      await cdp.detach();
    } catch (error) {
      report.environment.systemInfoUnavailable = cleanText(error);
    }
    context = await browser.newContext({
      viewport: report.targets.viewportCss,
      deviceScaleFactor: 1,
      serviceWorkers: "block",
      ...(values.video
        ? {
            recordVideo: {
              dir: resolve(output, "video"),
              size: report.targets.viewportCss,
            },
          }
        : {}),
    });
    await context.route(
      (url) => url.origin !== target.origin,
      async (route) => {
        report.requests.blockedCrossOrigin++;
        await route.abort("blockedbyclient");
      },
    );
    await context.routeWebSocket(
      (url) => {
        const http = new URL(url);
        http.protocol = http.protocol === "ws:" ? "http:" : "https:";
        return http.origin !== target.origin;
      },
      async (socket) => {
        report.requests.blockedCrossOrigin++;
        await socket.close({
          code: 1008,
          reason: "Evidence is same-origin only",
        });
      },
    );
    await context.addInitScript(installEvidence);
    const requests = new Map();
    context.on("request", (request) => {
      if (!sameOrigin(request.url())) return;
      const stats = report.requests;
      stats.started++;
      stats.active++;
      stats.peakActive = Math.max(stats.peakActive, stats.active);
      if (requests.size < 1024)
        requests.set(request, { phase: latestPhase, start: performance.now() });
    });
    const finishRequest = (request, failed) => {
      if (!sameOrigin(request.url())) return;
      const stats = report.requests,
        started = requests.get(request);
      requests.delete(request);
      stats.active = Math.max(0, stats.active - 1);
      if (failed) stats.failed++;
      else stats.finished++;
      const record = {
        path: new URL(request.url()).pathname,
        type: request.resourceType(),
        phase: started?.phase ?? "unknown",
        failed,
        durationMs: started ? performance.now() - started.start : null,
      };
      if (stats.records.length < 2000) stats.records.push(record);
      else stats.droppedRecords++;
      if (failed || metadata.size >= 64) {
        stats.sizeUnavailable++;
        return;
      }
      const work = request
        .sizes()
        .then((sizes) => {
          stats.responseBytes += sizes.responseBodySize;
        })
        .catch(() => {
          stats.sizeUnavailable++;
        });
      metadata.add(work);
      void work.finally(() => metadata.delete(work));
    };
    context.on("requestfinished", (request) => finishRequest(request, false));
    context.on("requestfailed", (request) => finishRequest(request, true));
    context.on("response", (response) => {
      if (!sameOrigin(response.url())) return;
      const status = String(response.status());
      report.requests.statuses[status] =
        (report.requests.statuses[status] ?? 0) + 1;
    });
    page = await context.newPage();
    video = page.video();
    page.setDefaultTimeout(15_000);
    page.on("pageerror", addError);
    page.on("console", (message) => {
      if (message.type() === "error") addError(message.text());
    });
    await page.goto(target.href, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.bringToFront();
    await page.waitForFunction(
      () => {
        const state = window.__map?.state();
        return (
          window.__map?.ready &&
          state?.lod?.firstVisible !== null &&
          state?.lod?.tiles > 0 &&
          state?.lod?.pending === 0 &&
          !state.renderPending
        );
      },
      undefined,
      { timeout: 90_000 },
    );
    report.environment.page = await page.evaluate(async () => {
      let adapterInfo = null,
        timestampQuery = null,
        adapterError = null;
      try {
        const adapter = await navigator.gpu?.requestAdapter();
        if (adapter) {
          const info =
            adapter.info ??
            (adapter.requestAdapterInfo
              ? await adapter.requestAdapterInfo()
              : null);
          adapterInfo = info
            ? {
                vendor: info.vendor,
                architecture: info.architecture,
                device: info.device,
                description: info.description,
                isFallbackAdapter:
                  info.isFallbackAdapter ?? adapter.isFallbackAdapter ?? null,
              }
            : null;
          timestampQuery = adapter.features.has("timestamp-query");
        }
      } catch (error) {
        adapterError = String(error);
      }
      const canvas = document.querySelector("#map"),
        main = document.querySelector("main").getBoundingClientRect();
      return {
        userAgent: navigator.userAgent,
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemoryGiB: navigator.deviceMemory ?? null,
        adapterInfo,
        timestampQuery,
        adapterError,
        canvas: { width: canvas.width, height: canvas.height },
        mainCss: { width: main.width, height: main.height },
        dpr: devicePixelRatio,
        visibility: document.visibilityState,
      };
    });
    report.gpuTimestamps.supportedByQueriedAdapter =
      report.environment.page.timestampQuery;
    report.environment.page.adapterError = report.environment.page.adapterError
      ? cleanText(report.environment.page.adapterError)
      : null;
    const software =
      /swiftshader|llvmpipe|software rasterizer|microsoft basic render/i.test(
        JSON.stringify([
          report.environment.chromeGpuDevices,
          report.environment.page.adapterInfo,
        ]),
      ) || report.environment.page.adapterInfo?.isFallbackAdapter === true;
    report.environment.softwareAdapterDetected = software;
    if (software)
      throw Error(
        "Software/fallback GPU detected; this is not a hardware Chrome performance baseline",
      );
    if (report.environment.page.visibility !== "visible")
      throw Error("Chrome must remain visible for this baseline");
    report.canvasTargetMet =
      report.environment.page.canvas.width === 1920 &&
      report.environment.page.canvas.height === 1080 &&
      report.environment.page.dpr === 1;
    await page.evaluate(
      ({ duration, workloadHz }) =>
        window.__lodEvidence.start(duration, workloadHz),
      { duration: seconds, workloadHz },
    );
    const captured = new Set();
    let previous = null;
    while (!stopSignal) {
      const sample = await page.evaluate(() => window.__lodEvidence.sample());
      latestPhase = sample.phase;
      sample.lod.failures = sample.lod.failures.map(cleanText);
      sample.failure = sample.failure ? cleanText(sample.failure) : null;
      sample.requests = {
        started: report.requests.started,
        finished: report.requests.finished,
        failed: report.requests.failed,
        active: report.requests.active,
      };
      const samePhase =
        previous &&
        previous.phase === sample.phase &&
        previous.cycle === sample.cycle;
      sample.frameWindowMs = samePhase ? sample.timeMs - previous.timeMs : null;
      sample.submittedFrames = samePhase ? sample.draws - previous.draws : null;
      sample.submittedFps =
        sample.frameWindowMs > 0
          ? (sample.submittedFrames * 1000) / sample.frameWindowMs
          : null;
      report.samples.push(sample);
      previous = sample;
      if (sample.failure) throw Error(sample.failure);
      if (sample.lod.memory.peakBytes > sample.lod.memory.limitBytes)
        throw Error("Application-owned memory exceeded its ledger ceiling");
      if (sample.visibility !== "visible")
        throw Error("Chrome became hidden; cadence baseline interrupted");
      if (
        sample.cycle === 0 &&
        ["coarse", "fine", "returned-coarse"].includes(sample.phase) &&
        sample.phaseElapsedMs >= 2000 &&
        !captured.has(sample.phase)
      ) {
        await capture(page, output, sample.phase, sample, report);
        captured.add(sample.phase);
      }
      if (sample.done) break;
      await delay(1000);
    }
    report.timing = await page.evaluate(() => window.__lodEvidence.stop());
    await page.evaluate(() => window.__map.fit());
    await page
      .waitForFunction(
        () =>
          window.__map.state().lod?.pending === 0 &&
          !window.__map.state().renderPending,
        undefined,
        { timeout: 30_000 },
      )
      .catch((error) => {
        report.fitSettleError = cleanText(error);
      });
    const final = await page.evaluate(() => window.__lodEvidence.sample());
    final.lod.failures = final.lod.failures.map(cleanText);
    report.final = final;
    await capture(page, output, "final-fit", final, report);
    report.status = stopSignal ? "interrupted" : "completed";
    report.signal = stopSignal;
    const histogram = report.timing.frames;
    const median = quantile(histogram, 0.5);
    report.observed = {
      rafCadenceHz: median ? 1000 / median : null,
      rafIntervalP50Ms: median,
      rafIntervalP95Ms: quantile(histogram, 0.95),
      rafIntervalP99Ms: quantile(histogram, 0.99),
      histogramQuantileResolutionMs: 0.25,
      wholeRunSubmittedFpsIncludingRest:
        report.timing.elapsedMs > 0
          ? (report.timing.submittedFrames * 1000) / report.timing.elapsedMs
          : null,
      peakApplicationBytes: Math.max(
        ...report.samples.map((sample) => sample.lod.memory.peakBytes),
        final.lod.memory.peakBytes,
      ),
      reachedFine: report.samples.some(
        (sample) => sample.phase === "fine" && sample.lod.level === 0,
      ),
      reachedCoarse: report.samples.some(
        (sample) => sample.phase === "coarse" && sample.lod.level > 0,
      ),
      returnedCoarse: report.samples.some(
        (sample) => sample.phase === "returned-coarse" && sample.lod.level > 0,
      ),
    };
    report.phaseTiming = Object.fromEntries(
      Object.entries(report.timing.phases).map(([phase, frames]) => {
        const { elapsedMs = 0, submittedFrames = 0 } =
          report.timing.submissions[phase] ?? {};
        const panUpdates = report.timing.workload.phases[phase] ?? 0;
        const p50 = quantile(frames, 0.5);
        return [
          phase,
          {
            rafIntervals: frames.count,
            rafCadenceHz: p50 ? 1000 / p50 : null,
            p50Ms: p50,
            p95Ms: quantile(frames, 0.95),
            p99Ms: quantile(frames, 0.99),
            submissionWindowMs: elapsedMs,
            submittedFrames,
            submittedFps: elapsedMs
              ? (submittedFrames * 1000) / elapsedMs
              : null,
            panUpdates,
            panInputHz: elapsedMs ? (panUpdates * 1000) / elapsedMs : null,
          },
        ];
      }),
    );
    report.movingPhaseTiming = Object.fromEntries(
      Object.entries(report.phaseTiming).filter(
        ([phase]) => phase !== "fit-rest",
      ),
    );
    report.sixtyHzBaseline = {
      manuallyConfigured: displayHz === 60,
      observedCadenceConsistent:
        median !== null && Math.abs(median - 1000 / 60) <= 1,
      qualifiedForComparison:
        displayHz === 60 &&
        median !== null &&
        Math.abs(median - 1000 / 60) <= 1 &&
        report.canvasTargetMet &&
        report.screenshots.every((screenshot) => screenshot.nonblank) &&
        report.errors.length === 0 &&
        !report.timing.hiddenFrames &&
        !stopSignal,
      assessment:
        "Use movingPhaseTiming for per-moving-phase histograms and submitted FPS. A 60 Hz pan-input cap does not qualify a physical 60 Hz display baseline or establish GPU completion at 60 Hz.",
    };
  } catch (error) {
    report.status = "failed";
    addError(error);
    process.exitCode = 1;
  } finally {
    try {
      if (page && !page.isClosed()) {
        try {
          report.timing ??= await page.evaluate(
            () => window.__lodEvidence?.stop() ?? null,
          );
        } catch {}
      }
      if (context) await context.close();
      if (video) report.video = "video/" + basename(await video.path());
    } catch (error) {
      addError(error);
      report.status = "failed";
      process.exitCode = 1;
    } finally {
      try {
        await browser?.close();
      } catch (error) {
        addError(error);
        process.exitCode = 1;
      }
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
    }
    await Promise.allSettled([...metadata]);
    report.finishedAt = new Date().toISOString();
    if (report.errors.length) {
      process.exitCode = 1;
      report.status = "failed";
    }
    await writeFile(
      resolve(output, "report.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    console.log(
      `LOD evidence ${report.status}: ${resolve(output, "report.json")}`,
    );
    console.log(
      `Snapshots: ${report.samples.length}; PNGs: ${report.screenshots.length}; errors: ${report.errors.length}`,
    );
  }
}

async function capture(page, output, name, sample, report) {
  await page.screenshot({ path: resolve(output, `${name}.png`) });
  const image = await page
    .locator("#map")
    .screenshot({ path: resolve(output, `${name}-canvas.png`) });
  const png = PNG.sync.read(image),
    colors = new Set();
  for (let y = 0; y < png.height; y += 13)
    for (let x = 0; x < png.width; x += 13) {
      const i = (y * png.width + x) * 4;
      colors.add(
        `${png.data[i] >> 3},${png.data[i + 1] >> 3},${png.data[i + 2] >> 3}`,
      );
    }
  report.screenshots.push({
    name,
    png: `${name}.png`,
    canvasPng: `${name}-canvas.png`,
    timeMs: sample.timeMs,
    level: sample.lod.level,
    scale: sample.camera.scale,
    width: png.width,
    height: png.height,
    sampledColors: colors.size,
    nonblank: colors.size > 20,
  });
}

function quantile(histogram, proportion) {
  if (!histogram?.count) return null;
  let count = 0;
  for (let i = 0; i < histogram.bins.length; i++) {
    count += histogram.bins[i];
    if (count >= histogram.count * proportion)
      return i === histogram.bins.length - 1
        ? histogram.maxMs
        : (i + 0.5) * histogram.binWidthMs;
  }
  return null;
}

// Runs only in the short-lived evidence context; it is never installed in app source.
function installEvidence() {
  const makeHistogram = () => ({
    binWidthMs: 0.25,
    overflowAtMs: 250,
    bins: new Array(1001).fill(0),
    count: 0,
    totalMs: 0,
    minMs: null,
    maxMs: 0,
  });
  const add = (histogram, value) => {
    histogram.bins[Math.min(1000, Math.floor(value / 0.25))]++;
    histogram.count++;
    histogram.totalMs += value;
    histogram.minMs =
      histogram.minMs === null ? value : Math.min(histogram.minMs, value);
    histogram.maxMs = Math.max(histogram.maxMs, value);
  };
  const state = {
    frames: makeHistogram(),
    phases: {},
    submissions: {},
    workload: { requestedHz: null, updates: 0, phases: {} },
    longTasks: {
      supported: false,
      count: 0,
      totalMs: 0,
      maxMs: 0,
      records: [],
      droppedRecords: 0,
    },
    hiddenFrames: 0,
  };
  let observer,
    raf = 0,
    start = null,
    end = null,
    duration = 0,
    previous = null;
  let phase = "startup",
    cycle = 0,
    phaseStart = 0,
    token = "",
    anchor = null,
    lastCamera = null;
  let initialDraws = 0,
    failure = null,
    running = false;
  let panIntervalMs = 0,
    lastPanTime = null;
  let submissionStart = null,
    submissionDraws = 0,
    submissionPhase = "coarse";
  const accountSubmissions = (now) => {
    if (submissionStart === null) return;
    const draws = window.__map.state().draws;
    const total = (state.submissions[submissionPhase] ??= {
      elapsedMs: 0,
      submittedFrames: 0,
    });
    total.elapsedMs += now - submissionStart;
    total.submittedFrames += draws - submissionDraws;
    submissionStart = now;
    submissionDraws = draws;
  };
  const phaseAt = (elapsed) => {
    const t = elapsed % 30_000;
    if (t < 4000) return ["coarse", t];
    if (t < 13_000) return ["fine", t - 4000];
    if (t < 21_000) return ["reversals", t - 13_000];
    if (t < 26_000) return ["returned-coarse", t - 21_000];
    return ["fit-rest", t - 26_000];
  };
  const frame = (now) => {
    if (!running) return;
    try {
      const elapsed = now - start;
      if (elapsed >= duration) {
        end = now;
        accountSubmissions(now);
        submissionStart = null;
        running = false;
        return;
      }
      const next = phaseAt(elapsed);
      phase = next[0];
      phaseStart = next[1];
      cycle = Math.floor(elapsed / 30_000);
      if (previous !== null) {
        const dt = now - previous;
        add(state.frames, dt);
        state.phases[phase] ??= makeHistogram();
        add(state.phases[phase], dt);
      }
      previous = now;
      if (document.hidden) state.hiddenFrames++;
      const nextToken = `${cycle}:${phase}`;
      if (nextToken !== token) {
        accountSubmissions(now);
        submissionPhase = phase;
        token = nextToken;
        if (phase === "fine" || phase === "reversals") {
          window.__map.spawn();
          window.__map.zoom(6 / window.__map.state().scale);
        } else {
          window.__map.fit();
          if (phase !== "fit-rest")
            window.__map.zoom(0.12 / window.__map.state().scale);
        }
        anchor = window.__map.state();
        lastCamera = { cx: anchor.cx, cz: anchor.cz };
      }
      // Keep rAF timing above this gate. Never replay missed workload updates.
      // The tiny tolerance absorbs floating-point arithmetic, not frame jitter.
      const panDue =
        lastPanTime === null || now - lastPanTime + 1e-6 >= panIntervalMs;
      if (phase !== "fit-rest" && panDue) {
        const fast = phase === "reversals",
          amount = fast ? 80 : phase === "fine" ? 12 : 8;
        const x = anchor.cx + Math.sin(phaseStart / (fast ? 90 : 700)) * amount;
        const z =
          anchor.cz + Math.sin(phaseStart / (fast ? 130 : 1100)) * amount * 0.6;
        window.__map.pan(x - lastCamera.cx, z - lastCamera.cz);
        lastCamera = { cx: x, cz: z };
        lastPanTime = now;
        state.workload.updates++;
        state.workload.phases[phase] = (state.workload.phases[phase] ?? 0) + 1;
      }
      raf = requestAnimationFrame(frame);
    } catch (error) {
      failure = String(error);
      running = false;
      end = performance.now();
    }
  };
  const sample = () => {
    const map = window.__map.state(),
      lod = map.lod;
    return {
      timeMs: performance.now(),
      elapsedMs: start === null ? 0 : (end ?? performance.now()) - start,
      phase,
      cycle,
      phaseElapsedMs: phaseStart,
      done: start !== null && !running,
      failure,
      visibility: document.visibilityState,
      draws: map.draws,
      panUpdates: state.workload.updates,
      camera: { cx: map.cx, cz: map.cz, scale: map.scale },
      lod: {
        level: lod.level,
        targetLevel: lod.targetLevel,
        tiles: lod.tiles,
        heights: lod.heights,
        indexes: lod.indexes,
        pending: lod.pending,
        firstVisible: lod.firstVisible,
        decodeMs: lod.decodeMs,
        tileUploads: lod.tileUploads,
        cancellations: lod.cancellations,
        retiringBytes: lod.retiringBytes,
        mainWasmBytes: lod.mainWasmBytes,
        workerWasmBytes: lod.workerWasmBytes,
        failures: lod.failures.slice(0, 8),
        memory: {
          limitBytes: lod.memory.limitBytes,
          totalBytes: lod.memory.totalBytes,
          capacityBytes: lod.memory.capacityBytes,
          reservedBytes: lod.memory.reservedBytes,
          peakBytes: lod.memory.peakBytes,
          freeBytes: lod.memory.freeBytes,
          categories: lod.memory.categories,
          entries: lod.memory.entries.length,
        },
      },
    };
  };
  window.__lodEvidence = {
    start(seconds, workloadHz = null) {
      if (start !== null)
        throw Error("Evidence monitor can only start once per context");
      window.__map.fit();
      duration = seconds * 1000;
      start = performance.now();
      initialDraws = window.__map.state().draws;
      submissionStart = start;
      submissionDraws = initialDraws;
      state.workload.requestedHz = workloadHz;
      panIntervalMs = workloadHz === null ? 0 : 1000 / workloadHz;
      running = true;
      if (PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
        state.longTasks.supported = true;
        observer = new PerformanceObserver((list) => {
          for (const task of list.getEntries()) {
            if (
              task.startTime < start ||
              (end !== null && task.startTime > end)
            )
              continue;
            const stats = state.longTasks;
            stats.count++;
            stats.totalMs += task.duration;
            stats.maxMs = Math.max(stats.maxMs, task.duration);
            if (stats.records.length < 256)
              stats.records.push({
                startTime: task.startTime,
                durationMs: task.duration,
                phase: phaseAt(task.startTime - start)[0],
              });
            else stats.droppedRecords++;
          }
        });
        observer.observe({ type: "longtask", buffered: false });
      }
      raf = requestAnimationFrame(frame);
    },
    sample,
    stop() {
      if (running) end = performance.now();
      accountSubmissions(end ?? performance.now());
      submissionStart = null;
      running = false;
      cancelAnimationFrame(raf);
      observer?.disconnect();
      return {
        ...state,
        timeOrigin: performance.timeOrigin,
        startTime: start,
        endTime: end,
        elapsedMs: start === null ? 0 : (end ?? performance.now()) - start,
        submittedFrames: Object.values(state.submissions).reduce(
          (sum, phase) => sum + phase.submittedFrames,
          0,
        ),
      };
    },
  };
}
