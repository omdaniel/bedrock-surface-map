import init, { Renderer } from "../pkg/surface_gpu.js";
import {
  createIcons,
  Maximize,
  MapPin,
  Plus,
  Minus,
  Grid2X2,
  Sun,
  Activity,
  RotateCcw,
  ChevronDown,
  SlidersHorizontal,
} from "lucide";
import type { Manifest, RegionRef, DecodeRequest, DecodeReply } from "./types";
import { bindSunDial } from "./sun-dial";
import { PlayerLayer } from "./players";
import { TerrainClient, type LiveRoot } from "./terrain";
import { boundedBytes } from "./http";
import { appUrl, loadConfiguration, type ViewerConfiguration } from "./config";
import { DemoPlayback } from "./demo";
import {
  MAP_CACHE_BYTES,
  REGION_BYTES,
  REGION_GPU_BYTES,
  heightWindowBytes,
} from "./cache-budget";
import "./style.css";

const DEFAULT_SUN_AZIMUTH = 330;
const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `<header><div class="identity"><span class="brand-mark" aria-hidden="true"></span><div><strong>Bedrock Surface Map</strong><span class="subtitle">OVERWORLD <span class="separator">/</span> SNAPSHOT</span></div></div><nav aria-label="Map tools"><button id="fit" title="Fit world" aria-label="Fit world"><i data-lucide="maximize"></i></button><button id="spawn" title="World spawn" aria-label="World spawn"><i data-lucide="map-pin"></i></button><span class="divider"></span><button id="grid" title="Block borders" aria-label="Block borders" aria-pressed="true"><i data-lucide="grid-2-x2"></i></button><button id="sun" title="Sun shadows" aria-label="Sun shadows" aria-pressed="true"><i data-lucide="sun"></i></button><button id="stats" title="Performance" aria-label="Performance" aria-pressed="false"><i data-lucide="activity"></i></button></nav></header><main><canvas id="map" aria-label="Interactive Bedrock world map" tabindex="0"></canvas><div id="message" role="status"><span id="message-text">Opening world...</span><button id="retry" hidden>Retry</button></div><div class="zoom"><button id="in" title="Zoom in" aria-label="Zoom in"><i data-lucide="plus"></i></button><button id="out" title="Zoom out" aria-label="Zoom out"><i data-lucide="minus"></i></button></div><div class="north" title="North">N<span aria-hidden="true">↑</span></div><section id="inspect" hidden><span class="eyebrow">SURFACE</span><strong id="block-name"></strong><span id="block-pos"></span><span id="block-detail"></span></section><section id="diagnostics" hidden><strong>Performance</strong><pre id="metrics"></pre><button id="measure">Measure 5 seconds</button></section><div id="scale"><div></div><span></span></div></main><footer><span id="coordinates">X — &nbsp; Z —</span><span id="load-state">Preparing renderer</span><span class="local-state"><b></b> Local snapshot</span></footer>`;
app
  .querySelector("#sun")!
  .insertAdjacentHTML(
    "afterend",
    `<button id="lighting-toggle" title="Lighting and color" aria-label="Lighting and color" aria-expanded="false" aria-controls="lighting"><i data-lucide="sliders-horizontal"></i></button>`,
  );
app.querySelector("main")!.insertAdjacentHTML(
  "beforeend",
  `<section id="lighting" aria-label="Lighting and color settings" hidden>
  <strong>Lighting and color</strong>
  <div class="azimuth-setting">
    <div class="azimuth-label"><span id="azimuth-label">Sun azimuth</span><output id="azimuth-value" for="azimuth">${DEFAULT_SUN_AZIMUTH}&deg;</output></div>
    <div id="azimuth" class="sun-dial" role="slider" tabindex="0" aria-labelledby="azimuth-label" aria-valuemin="0" aria-valuemax="359" aria-valuenow="${DEFAULT_SUN_AZIMUTH}" title="Sun bearing: N 0°, E 90°, S 180°, W 270°" style="--bearing:${DEFAULT_SUN_AZIMUTH}deg">
      <span class="dial-cardinal dial-north" aria-hidden="true">N</span><span class="dial-cardinal dial-east" aria-hidden="true">E</span><span class="dial-cardinal dial-south" aria-hidden="true">S</span><span class="dial-cardinal dial-west" aria-hidden="true">W</span>
      <span class="dial-track" aria-hidden="true"></span><span class="dial-hand" aria-hidden="true"><span><i data-lucide="sun"></i></span></span><span class="dial-hub" aria-hidden="true"></span>
    </div>
  </div>
  <div class="setting-label"><label for="elevation">Sun elevation</label><output id="elevation-value" for="elevation">45&deg;</output></div>
  <input id="elevation" type="range" min="15" max="75" step="5" value="45">
  <div class="setting-label"><label for="shadow-strength">Shadow strength</label><output id="strength-value" for="shadow-strength">55%</output></div>
  <input id="shadow-strength" type="range" min="0" max="80" step="5" value="55">
  <div class="setting-label"><label for="relief-strength">Terrain relief</label><output id="relief-value" for="relief-strength">100%</output></div>
  <input id="relief-strength" type="range" min="0" max="100" step="5" value="100">
  <div class="setting-label"><label for="relief-width">Edge width</label><output id="width-value" for="relief-width">0.25 blocks</output></div>
  <input id="relief-width" type="range" min="5" max="50" step="5" value="25">
  <div class="setting-label"><label for="color-treatment">Color treatment</label><select id="color-treatment"><option value="vivid">Vivid</option><option value="original">Original</option></select></div>
</section>`,
);
createIcons({
  icons: {
    Maximize,
    MapPin,
    Plus,
    Minus,
    Grid2X2,
    Sun,
    Activity,
    RotateCcw,
    ChevronDown,
    SlidersHorizontal,
  },
});
const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>("map");
const main = canvas.parentElement!;
app.insertBefore($("message"), main);
let manifest: Manifest;
let renderer: Renderer;
let base: URL;
let terrain: TerrainClient | null = null;
let demo: DemoPlayback | null = null;
let terrainBusy = false,
  terrainAgain = false,
  terrainPollAgain = false;
let terrainTimer: ReturnType<typeof setTimeout> | undefined;
let terrainFailures = 0;
let supportedView: [number, number, number, number] | null = null;
let capacityWarning = false;
let cx = 0,
  cz = 0,
  scale = 1,
  grid = true,
  sun = true,
  elevation = 45,
  azimuth = DEFAULT_SUN_AZIMUTH,
  shadowStrength = 0.55,
  vivid = true,
  reliefStrength = 1,
  reliefWidth = 0.25,
  frameQueued = false,
  disposed = false;
let sequence = 0,
  active = 0,
  started = performance.now(),
  firstVisible: number | null = null,
  totalDecode = 0,
  draws = 0;
const cache = new Map<
  string,
  { ref: RegionRef; pick: Int32Array; last: number }
>();
const loading = new Set<string>();
const failures = new Set<string>();
const pending = new Map<
  number,
  {
    resolve: (data: Uint32Array | Float32Array) => void;
    reject: (e: Error) => void;
  }
>();
const worker = new Worker(new URL("./decoder.worker.ts", import.meta.url), {
  type: "module",
});
const playerLayer = new PlayerLayer({
  main,
  nav: document.querySelector("nav")!,
  camera: () => ({
    cx,
    cz,
    scale,
    width: main.clientWidth,
    height: main.clientHeight,
  }),
  center: (x, z, close) => {
    if (!renderer) return;
    const targetScale = close ? Math.max(scale, 3) : scale;
    if (cx === x && cz === z && targetScale === scale) return;
    cx = x;
    cz = z;
    scale = targetScale;
    changed();
  },
  covered: (x, z) => {
    const rx = Math.floor(x / 256),
      rz = Math.floor(z / 256),
      r = cache.get(`${rx},${rz}`);
    if (!r)
      return manifest?.regions.some(
        (region) => region.rx === rx && region.rz === rz,
      )
        ? null
        : false;
    const ix =
      (((Math.floor(z) % 256) + 256) % 256) * 256 +
      (((Math.floor(x) % 256) + 256) % 256);
    return r.pick[ix * 2] !== -32768;
  },
});
worker.onmessage = ({ data: r }: MessageEvent<DecodeReply>) => {
  const p = pending.get(r.id);
  if (!p) return;
  pending.delete(r.id);
  totalDecode += r.decodeMs ?? 0;
  if (r.error) p.reject(new Error(r.error));
  else p.resolve(r.data!);
};
worker.onerror = (e) => {
  for (const p of pending.values()) p.reject(new Error(e.message));
  pending.clear();
  message(e.message, true);
};
function decode(request: Omit<DecodeRequest, "id">) {
  return new Promise<Uint32Array | Float32Array>((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    worker.postMessage({ ...request, id });
  });
}
function asset(path: string) {
  const url = new URL(path, base);
  if (url.origin !== location.origin)
    throw new Error(
      "Cross-origin map assets are disabled in the local prototype",
    );
  return url.href;
}
function message(text: string, retry = false) {
  $("message-text").textContent = text;
  $("message").hidden = !text;
  $("retry").hidden = !retry;
}
function key(r: RegionRef) {
  return `${r.rx},${r.rz}`;
}
function viewport() {
  return {
    left: cx - main.clientWidth / scale / 2,
    right: cx + main.clientWidth / scale / 2,
    top: cz - main.clientHeight / scale / 2,
    bottom: cz + main.clientHeight / scale / 2,
  };
}
function visible(r: RegionRef) {
  const v = viewport();
  return (
    r.rx * 256 <= v.right &&
    (r.rx + 1) * 256 >= v.left &&
    r.rz * 256 <= v.bottom &&
    (r.rz + 1) * 256 >= v.top
  );
}
function memory() {
  return renderer
    ? renderer.gpu_bytes() +
        renderer.cpu_bytes() +
        (terrain?.memoryBytes ?? 0) +
        [...cache.values()].reduce((n, r) => n + r.pick.byteLength, 0)
    : 0;
}
function makeSpace() {
  while (memory() + REGION_BYTES > MAP_CACHE_BYTES) {
    const victim = [...cache.entries()]
      .filter(([, v]) => !visible(v.ref))
      .sort((a, b) => a[1].last - b[1].last)[0];
    if (!victim) return false;
    renderer.remove_region(victim[1].ref.rx, victim[1].ref.rz);
    cache.delete(victim[0]);
  }
  return true;
}
function loadRegions() {
  if (
    !renderer ||
    disposed ||
    renderer.is_lost() ||
    terrainBusy ||
    needsHeightWindow()
  )
    return;
  const wanted = manifest.regions
    .filter(visible)
    .sort(
      (a, b) =>
        Math.hypot(a.rx * 256 + 128 - cx, a.rz * 256 + 128 - cz) -
        Math.hypot(b.rx * 256 + 128 - cx, b.rz * 256 + 128 - cz),
    );
  for (const r of wanted) {
    if (active >= 2) break;
    const k = key(r);
    if (cache.has(k) || loading.has(k) || failures.has(k)) continue;
    if (!makeSpace()) {
      message(
        "Visible area exceeds the 256 MiB cache. Zoom in to load more detail.",
      );
      break;
    }
    active++;
    loading.add(k);
    void decode({
      kind: "region",
      url: asset(r.url),
      sha256: r.sha256,
      rx: r.rx,
      rz: r.rz,
      materials: manifest.materials.length,
    })
      .then((data) => {
        if (
          disposed ||
          terrainBusy ||
          !manifest.regions.some((v) => key(v) === k && v.sha256 === r.sha256)
        )
          return;
        const words = data as Uint32Array;
        if (!makeSpace()) return;
        renderer.add_region(r.rx, r.rz, words);
        const pick = new Int32Array(65536 * 2);
        for (let i = 0; i < 65536; i++) {
          pick[i * 2] = words[i * 8 + 7] === 1 ? words[i * 8] | 0 : -32768;
          pick[i * 2 + 1] = words[i * 8 + 1];
        }
        cache.set(k, { ref: r, pick, last: performance.now() });
        requestDraw();
      })
      .catch((e) => {
        failures.add(k);
        message(String(e), true);
      })
      .finally(() => {
        active--;
        loading.delete(k);
        loadRegions();
        updateStatus();
      });
  }
  updateStatus();
}
function updateStatus() {
  if (!manifest) return;
  const wanted = manifest.regions.filter(visible);
  const ready = wanted.filter((r) => cache.has(key(r))).length;
  $("load-state").textContent =
    `${ready} / ${wanted.length} regions · ${Math.round(scale * 100)}%`;
  if (
    ready > 0 &&
    (!terrain || terrain.covers(viewport(), elevation)) &&
    !renderer.is_lost() &&
    active === 0 &&
    failures.size === 0 &&
    terrainFailures === 0 &&
    !capacityWarning &&
    ready === wanted.length
  )
    message("");
}
function updateMetrics() {
  if (!renderer) return;
  $("metrics").textContent =
    `Cached regions  ${cache.size}\nMap memory      ${(memory() / 1048576).toFixed(1)} MiB\nWorker decode   ${totalDecode.toFixed(0)} ms\nFirst region    ${firstVisible?.toFixed(0) ?? "—"} ms\nFrames drawn    ${draws}`;
}
function updateScale() {
  const maxBlocks = 100 / scale;
  const pow = 10 ** Math.floor(Math.log10(maxBlocks));
  const blocks =
    [5, 2, 1].map((v) => v * pow).find((v) => v <= maxBlocks) ?? pow / 2;
  const el = $("scale");
  el.querySelector("div")!.style.width = `${blocks * scale}px`;
  el.querySelector("span")!.textContent = `${blocks.toLocaleString()} blocks`;
}
function requestDraw() {
  if (frameQueued || !renderer || disposed) return;
  if (terrain && !terrain.covers(viewport(), elevation)) return;
  frameQueued = true;
  requestAnimationFrame(() => {
    frameQueued = false;
    try {
      const dpr = Math.min(devicePixelRatio, 2);
      const w = Math.round(main.clientWidth * dpr),
        h = Math.round(main.clientHeight * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      renderer.render(
        cx,
        cz,
        scale * dpr,
        w,
        h,
        grid,
        sun,
        elevation,
        azimuth,
        shadowStrength,
        vivid,
        reliefStrength,
        reliefWidth,
      );
      draws++;
      playerLayer.project();
      updateScale();
      updateMetrics();
    } catch (e) {
      message(String(e), true);
    }
  });
}
function fixedMapBytes() {
  return (
    renderer.gpu_bytes() - renderer.cpu_bytes() - cache.size * REGION_GPU_BYTES
  );
}
function viewFits() {
  const heights = terrain
    ? heightWindowBytes(terrain.needed(viewport(), elevation))
    : renderer.cpu_bytes() * 2;
  return (
    fixedMapBytes() +
      heights +
      manifest.regions.filter(visible).length * REGION_BYTES <=
    MAP_CACHE_BYTES
  );
}
function admitView(resized: boolean) {
  if (viewFits()) {
    supportedView = [cx, cz, scale, elevation];
    if (!resized) capacityWarning = false;
    return true;
  }
  if (supportedView) [cx, cz, scale, elevation] = supportedView;
  // A resized viewport can outgrow the last supported camera too.
  while (!viewFits() && scale < 80) scale = Math.min(80, scale * 1.5);
  $<HTMLInputElement>("elevation").value = String(elevation);
  $("elevation-value").textContent = `${elevation}\u00b0`;
  capacityWarning = true;
  message(
    "Visible area exceeds the 256 MiB cache. Keeping a supported view. Zoom in for more detail.",
  );
  if (!viewFits()) return false;
  supportedView = [cx, cz, scale, elevation];
  return true;
}
function changed(resized = false) {
  if (!renderer || !manifest || !admitView(resized)) return;
  for (const c of cache.values())
    if (visible(c.ref)) c.last = performance.now();
  if (needsHeightWindow()) void syncTerrain();
  else loadRegions();
  requestDraw();
}

function materialWords(value: Manifest) {
  return new Float32Array(
    value.materials.flatMap((m) => [
      ...m.uv,
      ...m.average,
      m.tint,
      Number(m.name.toLowerCase() === "sand"),
      0,
      0,
    ]),
  );
}
function updatePick(ref: RegionRef, words: Uint32Array) {
  const pick = new Int32Array(65536 * 2);
  for (let i = 0; i < 65536; i++) {
    pick[i * 2] = words[i * 8 + 7] === 1 ? words[i * 8] | 0 : -32768;
    pick[i * 2 + 1] = words[i * 8 + 1];
  }
  cache.set(key(ref), { ref, pick, last: performance.now() });
}
function terrainBudget() {
  const missing = manifest.regions.filter(
    (r) => visible(r) && !cache.has(key(r)),
  ).length;
  // Reserve all visible detail before enlarging the height window, not just
  // regions that have already arrived. Nonvisible detail can be evicted on retry.
  return (
    MAP_CACHE_BYTES - fixedMapBytes() - (cache.size + missing) * REGION_BYTES
  );
}
function needsHeightWindow() {
  return (
    terrain !== null &&
    (!terrain.covers(viewport(), elevation) ||
      renderer.cpu_bytes() * 2 + terrain.memoryBytes > terrainBudget())
  );
}
async function syncTerrain(poll = false) {
  if (
    !terrain ||
    !renderer ||
    disposed ||
    document.hidden ||
    renderer.is_lost()
  )
    return;
  if (terrainBusy) {
    terrainAgain = true;
    terrainPollAgain ||= poll;
    return;
  }
  terrainBusy = true;
  const camera = [cx, cz, scale, elevation].join(",");
  try {
    let update;
    try {
      update = await terrain.prepare(
        cache,
        viewport(),
        elevation,
        poll,
        terrainBudget(),
      );
    } catch (error) {
      if (!String(error).includes("cache")) throw error;
      for (const [k, r] of cache)
        if (!visible(r.ref)) {
          renderer.remove_region(r.ref.rx, r.ref.rz);
          cache.delete(k);
        }
      update = await terrain.prepare(
        cache,
        viewport(),
        elevation,
        poll,
        terrainBudget(),
      );
    }
    if (camera !== [cx, cz, scale, elevation].join(",")) {
      terrainAgain = true;
      return;
    }
    const changedCatalog =
      manifest.catalog_version !== update.manifest.catalog_version;
    if (manifest.atlas !== update.manifest.atlas)
      throw Error("Terrain texture set changed; reload required");
    if (changedCatalog)
      renderer.update_materials(materialWords(update.manifest));
    if (update.heights)
      renderer.set_height_window(new Int32Array(update.window), update.heights);
    else
      for (const p of update.heightPatches)
        renderer.patch_height_region(p.rx, p.rz, p.values);
    for (const { ref, words } of update.replacements) {
      renderer.add_region(ref.rx, ref.rz, words);
      updatePick(ref, words);
    }
    for (const p of update.patches) {
      const cached = cache.get(
        `${Math.floor(p.cx / 16)},${Math.floor(p.cz / 16)}`,
      );
      if (!cached) continue;
      renderer.patch_chunk(p.cx, p.cz, p.words);
      const ox = (((p.cx % 16) + 16) % 16) * 16,
        oz = (((p.cz % 16) + 16) % 16) * 16;
      for (let i = 0; i < 256; i++) {
        const ix = (oz + Math.floor(i / 16)) * 256 + ox + (i % 16);
        cached.pick[ix * 2] =
          p.words[i * 8 + 7] === 1 ? p.words[i * 8] | 0 : -32768;
        cached.pick[ix * 2 + 1] = p.words[i * 8 + 1];
      }
    }
    manifest = update.manifest;
    terrain.commit(update);
    for (const r of manifest.regions) {
      const cached = cache.get(key(r));
      if (cached) cached.ref = r;
    }
    if (
      update.heights ||
      update.heightPatches.length ||
      update.patches.length ||
      update.replacements.length ||
      changedCatalog
    )
      requestDraw();
    terrainFailures = 0;
    if (poll && !demo) {
      // A cold-load object may have expired while a newer manifest was being
      // published. Retry against current references after successful revalidation.
      failures.clear();
      const response = await fetch(new URL("status", terrain.base), {
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw Error("Terrain status unavailable");
      const status = await response.json();
      if (
        status.world_id !== terrain.root.world_id ||
        status.generation !== terrain.root.generation
      )
        throw Error("Terrain status identity mismatch");
      const state = document.querySelector<HTMLElement>(".local-state")!;
      state.textContent = `Terrain ${String(status.status)}`;
      state.title = `Last repair: ${status.last_repair_ms ? new Date(status.last_repair_ms).toLocaleString() : "not yet"}; queued chunks: ${Number(status.diagnostics?.queued ?? 0)}`;
    }
  } catch (error) {
    terrainFailures++;
    document.querySelector<HTMLElement>(".local-state")!.textContent =
      "Terrain delayed";
    if (
      !terrain.covers(viewport(), elevation) ||
      String(error).includes("reload")
    )
      message(String(error), true);
  } finally {
    terrainBusy = false;
    loadRegions();
    updateStatus();
    if (terrainAgain) {
      const againPoll = terrainPollAgain;
      terrainAgain = false;
      terrainPollAgain = false;
      void syncTerrain(againPoll);
    }
  }
}
function scheduleTerrain() {
  if (terrainTimer) clearTimeout(terrainTimer);
  if (!terrain || disposed || document.hidden) return;
  terrainTimer = setTimeout(
    async () => {
      await syncTerrain(true);
      scheduleTerrain();
    },
    Math.min(30000, 2000 * 2 ** Math.min(terrainFailures, 4)),
  );
}
function fit() {
  playerLayer.manualNavigation();
  if (!manifest) return;
  const [x, z, xx, zz] = manifest.bounds;
  cx = (x + xx) / 2;
  cz = (z + zz) / 2;
  scale = Math.min(
    main.clientWidth / (xx - x + 64),
    main.clientHeight / (zz - z + 64),
  );
  changed();
}
function zoom(
  factor: number,
  x = main.clientWidth / 2,
  y = main.clientHeight / 2,
) {
  playerLayer.manualNavigation();
  const wx = cx + (x - main.clientWidth / 2) / scale,
    wz = cz + (y - main.clientHeight / 2) / scale;
  scale = Math.max(0.025, Math.min(80, scale * factor));
  cx = wx - (x - main.clientWidth / 2) / scale;
  cz = wz - (y - main.clientHeight / 2) / scale;
  changed();
}
function spawn() {
  playerLayer.manualNavigation();
  cx = manifest.spawn[0];
  cz = manifest.spawn[2];
  scale = 3;
  changed();
}
function inspect(x: number, y: number) {
  const wx = Math.floor(cx + (x - main.clientWidth / 2) / scale),
    wz = Math.floor(cz + (y - main.clientHeight / 2) / scale);
  $("coordinates").textContent =
    `X ${wx.toLocaleString()}   Z ${wz.toLocaleString()}`;
  const r = cache.get(`${Math.floor(wx / 256)},${Math.floor(wz / 256)}`);
  const ix = (((wz % 256) + 256) % 256) * 256 + (((wx % 256) + 256) % 256);
  const h = r?.pick[ix * 2];
  if (h === undefined || h === -32768) {
    $("inspect").hidden = true;
    return;
  }
  const m = manifest.materials[r!.pick[ix * 2 + 1]];
  $("inspect").hidden = false;
  $("block-name").textContent = m.name.replaceAll("_", " ");
  $("block-pos").textContent =
    `${wx} / ${(h / 16).toFixed(h % 16 ? 1 : 0)} / ${wz}`;
  $("block-detail").textContent = m.approximate
    ? "Top-surface approximation"
    : "";
}
const points = new Map<number, { x: number; y: number }>();
let previous: { x: number; y: number; distance: number } | null = null;
function centroid() {
  const p = [...points.values()];
  return {
    x: p.reduce((n, v) => n + v.x, 0) / p.length,
    y: p.reduce((n, v) => n + v.y, 0) / p.length,
    distance: p.length === 2 ? Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) : 0,
  };
}
canvas.onpointerdown = (e) => {
  playerLayer.manualNavigation();
  canvas.setPointerCapture(e.pointerId);
  points.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
  previous = centroid();
  canvas.classList.add("dragging");
};
canvas.onpointermove = (e) => {
  if (points.has(e.pointerId)) {
    points.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    const now = centroid();
    if (previous) {
      cx -= (now.x - previous.x) / scale;
      cz -= (now.y - previous.y) / scale;
      if (now.distance && previous.distance)
        zoom(now.distance / previous.distance, now.x, now.y);
    }
    previous = now;
    changed();
  } else inspect(e.offsetX, e.offsetY);
};
const endPointer = (e: PointerEvent) => {
  points.delete(e.pointerId);
  previous = points.size ? centroid() : null;
  if (!points.size) canvas.classList.remove("dragging");
};
canvas.onpointerup = endPointer;
canvas.onpointercancel = endPointer;
canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    zoom(Math.exp(-e.deltaY * 0.002), e.offsetX, e.offsetY);
  },
  { passive: false },
);
canvas.onkeydown = (e) => {
  playerLayer.manualNavigation();
  const delta = 80 / scale;
  if (e.key === "ArrowLeft") cx -= delta;
  else if (e.key === "ArrowRight") cx += delta;
  else if (e.key === "ArrowUp") cz -= delta;
  else if (e.key === "ArrowDown") cz += delta;
  else if (e.key === "+") zoom(1.5);
  else if (e.key === "-") zoom(1 / 1.5);
  else return;
  e.preventDefault();
  changed();
};
$("fit").onclick = fit;
$("spawn").onclick = spawn;
$("in").onclick = () => zoom(1.5);
$("out").onclick = () => zoom(1 / 1.5);
$("grid").onclick = () => {
  grid = !grid;
  $("grid").setAttribute("aria-pressed", String(grid));
  requestDraw();
};
$("sun").onclick = () => {
  sun = !sun;
  $("sun").setAttribute("aria-pressed", String(sun));
  requestDraw();
};
$("lighting-toggle").onclick = () => {
  playerLayer.close();
  const show = $("lighting").hidden;
  $("lighting").hidden = !show;
  $("lighting-toggle").setAttribute("aria-expanded", String(show));
  if (show) {
    $("diagnostics").hidden = true;
    $("stats").setAttribute("aria-pressed", "false");
  }
};
bindSunDial(
  $("azimuth"),
  $<HTMLOutputElement>("azimuth-value"),
  azimuth,
  (value) => {
    azimuth = value;
    requestDraw();
  },
);
$("elevation").oninput = () => {
  elevation = Number($<HTMLInputElement>("elevation").value);
  $("elevation-value").textContent = `${elevation}\u00b0`;
  changed();
};
$("shadow-strength").oninput = () => {
  shadowStrength = Number($<HTMLInputElement>("shadow-strength").value) / 100;
  $("strength-value").textContent = `${Math.round(shadowStrength * 100)}%`;
  requestDraw();
};
$("relief-strength").oninput = () => {
  reliefStrength = Number($<HTMLInputElement>("relief-strength").value) / 100;
  $("relief-value").textContent = `${Math.round(reliefStrength * 100)}%`;
  requestDraw();
};
$("relief-width").oninput = () => {
  reliefWidth = Number($<HTMLInputElement>("relief-width").value) / 100;
  $("width-value").textContent = `${reliefWidth.toFixed(2)} blocks`;
  requestDraw();
};
$("color-treatment").onchange = () => {
  vivid = $<HTMLSelectElement>("color-treatment").value === "vivid";
  requestDraw();
};
$("stats").onclick = () => {
  const show = $("diagnostics").hidden;
  if (show) playerLayer.close();
  $("diagnostics").hidden = !show;
  $("stats").setAttribute("aria-pressed", String(show));
  if (show) {
    $("lighting").hidden = true;
    $("lighting-toggle").setAttribute("aria-expanded", "false");
  }
  updateMetrics();
};
$("retry").onclick = () => {
  if (renderer?.is_lost()) {
    location.reload();
    return;
  }
  failures.clear();
  if (terrain) void syncTerrain(true);
  message("Retrying map data...");
  changed();
};
let resizeQueued = false;
new ResizeObserver(() => {
  if (resizeQueued || disposed) return;
  resizeQueued = true;
  requestAnimationFrame(() => {
    resizeQueued = false;
    if (!disposed) changed(true);
  });
}).observe(main);
document.addEventListener("visibilitychange", () => {
  if (terrainTimer) clearTimeout(terrainTimer);
  if (!document.hidden) {
    requestDraw();
    if (terrain) void syncTerrain(true).finally(scheduleTerrain);
  }
});
window.addEventListener("pagehide", () => {
  playerLayer.destroy();
  demo?.destroy();
  disposed = true;
  if (terrainTimer) clearTimeout(terrainTimer);
  worker.terminate();
  renderer?.free();
});
window.addEventListener("surface-device-lost", () =>
  message("GPU device lost. Reload the map.", true),
);
window.addEventListener("surface-frame-ready", () =>
  requestAnimationFrame(() => {
    if (firstVisible === null) {
      firstVisible = performance.now() - started;
      updateMetrics();
    }
  }),
);

async function measure() {
  const times: number[] = [];
  const original = [cx, cz, scale];
  const startDraws = draws;
  let previous = performance.now();
  const start = previous;
  await new Promise<void>((resolve) => {
    function step(now: number) {
      times.push(now - previous);
      previous = now;
      cx = original[0] + Math.sin((now - start) / 700) * 10;
      cz = original[1];
      scale = original[2];
      requestDraw();
      if (now - start < 5000) requestAnimationFrame(step);
      else resolve();
    }
    requestAnimationFrame(step);
  });
  cx = original[0];
  cz = original[1];
  changed();
  times.shift();
  times.sort((a, b) => a - b);
  const result = {
    kind: "animation-frame intervals during controlled pan, not GPU timestamps",
    frames: times.length,
    submitted_frames: draws - startDraws,
    scale: original[2],
    p50_ms: times[Math.floor(times.length * 0.5)],
    p95_ms: times[Math.floor(times.length * 0.95)],
    max_ms: times.at(-1),
    width: canvas.width,
    height: canvas.height,
    dpr: devicePixelRatio,
  };
  $("metrics").textContent += `\n\n${JSON.stringify(result, null, 2)}`;
  return result;
}
$("measure").onclick = () => {
  void measure();
};
declare global {
  interface Window {
    __map: {
      ready: boolean;
      state: () => ReturnType<typeof mapState>;
      fit: () => void;
      spawn: () => void;
      zoom: (factor: number) => void;
      measure: () => Promise<unknown>;
      loseDevice: () => void;
      pan: (x: number, z: number) => void;
    };
  }
}
function mapState() {
  return {
    cx,
    cz,
    scale,
    elevation,
    azimuth,
    azimuthConvention: "north-clockwise",
    shadowStrength,
    vivid,
    reliefStrength,
    reliefWidth,
    cached: cache.size,
    pending: active,
    failures: [...failures],
    memory: memory(),
    draws,
    firstVisible,
    totalDecode,
    terrain: terrain
      ? {
          revision: terrain.root.revision,
          changedChunks: terrain.changedChunks,
          window: terrain.window,
          bytesReceived: terrain.bytesReceived,
          busy: terrainBusy,
        }
      : null,
  };
}
window.__map = {
  ready: false,
  state: mapState,
  fit,
  spawn,
  zoom,
  measure,
  loseDevice: () => {
    renderer.simulate_device_loss();
  },
  pan: (x, z) => {
    playerLayer.manualNavigation();
    cx += x;
    cz += z;
    changed();
  },
};

async function boot() {
  const params = new URLSearchParams(location.search);
  const demoMode = import.meta.env.VITE_SURFACE_DEMO === "true";
  const configuration: ViewerConfiguration =
    !demoMode &&
    params.get("players") === "off" &&
    params.get("map")?.startsWith("/maps/")
      ? {}
      : await loadConfiguration().catch(() => ({}));
  if (demoMode && !configuration.demo)
    throw Error("Public demo configuration missing");
  if (!("gpu" in navigator) || !navigator.gpu) {
    if (demoMode && configuration.demo) {
      const poster = document.createElement("img");
      poster.src = appUrl(configuration.demo.poster).href;
      poster.alt =
        "Coastal Showcase with fictional players and simulated terrain changes";
      poster.className = "demo-poster";
      $("message").append(poster);
    }
    throw new Error(
      "WebGPU is unavailable. Open this demo in a WebGPU-enabled Chrome or Safari browser. The image is a preview, not an alternative renderer.",
    );
  }
  if (demoMode) {
    demo = new DemoPlayback();
    await demo.initialize(appUrl(configuration.demo!.scenario));
  }
  const url = new URL(
    (demo ? appUrl(configuration.demo!.scenario).href : params.get("map")) ??
      (params.get("terrain") === "off"
        ? undefined
        : configuration.terrain?.url) ??
      appUrl(configuration.map ?? "maps/world/manifest.json").href,
    location.href,
  );
  if (url.origin !== location.origin)
    throw new Error("Map must use this local origin");
  base = new URL(".", url);
  let raw;
  if (demo) raw = await demo.root();
  else {
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok)
      throw new Error(
        "No imported map found. Run the snapshot import command, then retry.",
      );
    raw = JSON.parse(
      new TextDecoder().decode(await boundedBytes(response, 16 * 1024 * 1024)),
    );
  }
  if (raw.format_version === 2) {
    if (
      !demo &&
      (!configuration.terrain ||
        configuration.terrain.world_id !== raw.world_id ||
        configuration.terrain.generation !== raw.generation ||
        new URL(configuration.terrain.url, location.href).href !== url.href)
    )
      throw Error("No explicit live-terrain binding for this map");
    terrain = new TerrainClient(
      url,
      raw as LiveRoot,
      decode,
      demo ? () => demo!.root() : undefined,
    );
    manifest = await terrain.initialize();
    document.querySelector(".subtitle")!.textContent = demo
      ? "OVERWORLD / DEMO"
      : "OVERWORLD / LIVE";
  } else manifest = raw;
  if (
    ![1, 2].includes(manifest.format_version) ||
    !Array.isArray(manifest.bounds) ||
    manifest.bounds.length !== 4 ||
    !manifest.bounds.every(
      (v) => Number.isInteger(v) && Math.abs(v) <= 8388608,
    ) ||
    !Array.isArray(manifest.regions) ||
    !manifest.regions.length ||
    manifest.regions.length > (terrain ? 65536 : 4096) ||
    !Array.isArray(manifest.materials) ||
    !manifest.materials.length ||
    manifest.materials.length > 65536 ||
    !Array.isArray(manifest.spawn) ||
    manifest.spawn.length !== 3 ||
    !manifest.spawn.every(Number.isFinite)
  )
    throw new Error("Unsupported or empty map manifest");
  $("app").querySelector(".identity strong")!.textContent = manifest.name;
  const width = manifest.bounds[2] - manifest.bounds[0],
    height = manifest.bounds[3] - manifest.bounds[1];
  if (
    width <= 0 ||
    height <= 0 ||
    (!terrain && width * height > 16 * 1024 * 1024)
  )
    throw new Error("Map bounds exceed the prototype limit");
  const ids = new Set<string>();
  for (const r of manifest.regions) {
    const k = key(r);
    if (
      !Number.isInteger(r.rx) ||
      !Number.isInteger(r.rz) ||
      ids.has(k) ||
      r.rx * 256 < manifest.bounds[0] ||
      r.rz * 256 < manifest.bounds[1] ||
      (r.rx + 1) * 256 > manifest.bounds[2] ||
      (r.rz + 1) * 256 > manifest.bounds[3]
    )
      throw new Error("Invalid region reference");
    ids.add(k);
  }
  for (const m of manifest.materials) {
    if (
      m.uv.length !== 4 ||
      m.average.length !== 4 ||
      ![...m.uv, ...m.average, m.tint].every(Number.isFinite)
    )
      throw new Error("Invalid material catalog");
  }
  const image = new Image();
  image.src = asset(manifest.atlas);
  await image.decode();
  if (
    image.width < 4 ||
    image.height < 4 ||
    image.width > 8192 ||
    image.height > 8192 ||
    image.width * image.height > 8 * 1024 * 1024
  )
    throw new Error("Texture atlas exceeds the prototype limit");
  const c = document.createElement("canvas");
  c.width = image.width;
  c.height = image.height;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(image, 0, 0);
  const rgba = ctx.getImageData(0, 0, c.width, c.height).data;
  message("Preparing terrain and sunlight...");
  await init();
  let bounds = manifest.bounds;
  let heights: Float32Array;
  if (terrain) {
    cx = (bounds[0] + bounds[2]) / 2;
    cz = (bounds[1] + bounds[3]) / 2;
    scale = Math.min(
      main.clientWidth / (width + 64),
      main.clientHeight / (height + 64),
    );
    if (demo) [cx, cz, scale] = demo.camera;
    const budget = () =>
      MAP_CACHE_BYTES -
      manifest.regions.filter(visible).length * REGION_BYTES -
      (rgba.byteLength * 21) / 16 -
      manifest.materials.length * 48;
    let update;
    try {
      update = await terrain.prepare(
        new Map(),
        viewport(),
        elevation,
        false,
        budget(),
      );
    } catch (error) {
      if (!String(error).includes("cache")) throw error;
      cx = manifest.spawn[0];
      cz = manifest.spawn[2];
      scale = 3;
      update = await terrain.prepare(
        new Map(),
        viewport(),
        elevation,
        false,
        budget(),
      );
    }
    bounds = update.window;
    heights = update.heights!;
    terrain.commit(update);
  } else
    heights = (await decode({
      kind: "heights",
      url: asset(manifest.heights),
      sha256: manifest.heights_sha256,
      columns: width * height,
    })) as Float32Array;
  const materials = materialWords(manifest);
  renderer = await Renderer.create(
    canvas,
    new Int32Array(bounds),
    heights,
    materials,
    new Uint8Array(rgba.buffer),
    c.width,
    c.height,
  );
  supportedView = [cx, cz, scale, elevation];
  window.__map.ready = true;
  if (demo) {
    demo.mount();
    document.querySelector<HTMLElement>(".local-state")!.textContent =
      "Simulated terrain";
    playerLayer.configureDemo(demo);
  }
  if (terrain) {
    changed();
    void syncTerrain(true).finally(scheduleTerrain);
  } else fit();
  if (demo) return;
  if (new URLSearchParams(location.search).get("players") === "off")
    playerLayer.disableForView();
  else
    void playerLayer.configure(
      manifest.source_sha256,
      terrain
        ? {
            world_id: terrain.root.world_id,
            generation: terrain.root.generation,
          }
        : undefined,
      configuration,
    );
}
void boot().catch((e) => {
  message(String(e), true);
  $("retry").onclick = () => location.reload();
  console.error(e);
});
