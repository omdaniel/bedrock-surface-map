import { Renderer } from "../../pkg/surface_gpu.js";
import { MAP_CACHE_BYTES, WORKING_BYTES } from "../cache-budget";
import {
  configureObjectCache,
  objectCacheStats,
  type ObjectCacheOptions,
} from "../object-cache";
import type { Manifest, Material } from "../types";
import { PyramidSource } from "./source";
import { TileDecoder } from "./tile-decoder";
import { TileJobs, type TileJob } from "./jobs";
import { planDemand, type DemandPlan } from "./demand";
import {
  catalogPagesForMask,
  tileId,
  tileBounds,
  type TileKey,
  type LodNode,
} from "./protocol";
import {
  desiredLevel,
  shadowBounds,
  type Bounds,
  type View,
} from "./selection";
import {
  planHeightWindow,
  buildHeightWindow,
  coversPlan,
  type HeightPlan,
} from "./heights";
import { buildDrawCut, pickDrawTile, type DrawTile } from "./cut";

// A fixed admission ceiling covers surfaces, picking and height pages. Decoding,
// replacement heights and WASM capacity have separate headroom below the map cap.
const TILE_BYTES = 611684 + 131072 + 65536;
const MAX_SURFACE_TILES = 160;
const MAX_HEIGHT_PAGES = 256;
const RESERVE = WORKING_BYTES + 32 * 1024 * 1024;

export interface MapDemand {
  view: View;
  scale: number;
  elevation: number;
  azimuth: number;
}
type Resident = {
  key: TileKey;
  node: LodNode;
  pick: Int32Array;
  pendingPick?: Int32Array;
  heights: Float32Array;
  revision: number;
  last: number;
};
type Result = {
  key: TileKey;
  node: LodNode | null;
  kind: "surface" | "height";
  words?: Uint32Array;
  pick?: Int32Array;
  heights?: Float32Array;
  revision: number;
};

/** The client owns its demand and residency. The source is an ordinary immutable
 * object hierarchy: no camera state, subscriptions or acknowledgments are sent.
 */
export class PyramidMap {
  readonly source: PyramidSource;
  readonly decoder: TileDecoder;
  renderer!: Renderer;
  manifest!: Manifest;
  level = 0;
  private jobs = new TileJobs<void>(2, 512);
  private residents = new Map<string, Resident>();
  private heights = new Map<
    string,
    {
      values: Float32Array | null;
      revision: number;
      last: number;
      hash: string;
    }
  >();
  private absent = new Map<string, number>();
  private errors = new Map<
    string,
    { until: number; attempts: number; text: string }
  >();
  private queue: { result: Result; signal: AbortSignal; done: () => void }[] =
    [];
  private catalog = new Map<number, { hash: string; materials: Material[] }>();
  private materialData!: Float32Array;
  private demand?: MapDemand;
  private plan?: DemandPlan;
  private disposed = false;
  private pollTimer?: ReturnType<typeof setTimeout>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private polling = false;
  private requiresReload = false;
  private pollFailures = 0;
  private changedContent = true;
  private previousCenter?: { x: number; z: number; time: number };
  private velocity = { x: 0, z: 0 };
  private epoch = 0;
  private scheduled = false;
  private used = new Set<string>();
  private prepared = false;
  private windowSignature = "";
  private heightsDirty = true;
  private heightPlan: HeightPlan | null = null;
  private activeHeightPlan: HeightPlan | null = null;
  private cut: DrawTile[] = [];
  private cutSignature = "";
  private maxCharged = 0;
  private statusError = "";
  private lastPanHit = false;
  private framesWithFallback = 0;
  constructor(
    url: URL,
    private redraw: () => void,
    cache?: ObjectCacheOptions,
    private mainWasm?: WebAssembly.Memory,
  ) {
    this.source = new PyramidSource(url);
    this.decoder = new TileDecoder(cache);
    void configureObjectCache(
      cache ?? { enabled: true, maxBytes: 256 * 1024 * 1024 },
    );
  }
  async initialize(canvas: HTMLCanvasElement) {
    await this.source.refresh(AbortSignal.timeout(15000));
    const root = this.source.root;
    this.level = root.roots[0].key.level;
    this.materialData = new Float32Array(root.material_count * 12);
    this.manifest = {
      format_version: 1,
      name: root.name,
      bounds: root.bounds,
      spawn: root.spawn,
      source_sha256: root.source_sha256,
      catalog_version: root.appearance_version,
      materials: [],
      atlas: root.atlas.url,
      regions: [],
      heights: "",
      heights_sha256: "",
      height_range: root.height_range,
      approximations: [],
    };
    const raw = await this.source.object(
      root.atlas,
      AbortSignal.timeout(15000),
      32 * 1024 * 1024,
    );
    const bitmap = await createImageBitmap(new Blob([raw]));
    try {
      if (
        bitmap.width < 4 ||
        bitmap.height < 4 ||
        bitmap.width * bitmap.height > 8 * 1024 * 1024
      )
        throw Error("Texture atlas exceeds the supported size");
      const canvas2d = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas2d.getContext("2d")!;
      ctx.drawImage(bitmap, 0, 0);
      const pixels = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      this.renderer = await Renderer.create(
        canvas,
        new Int32Array([0, 0, 1, 1]),
        new Float32Array([-1e6]),
        this.materialData,
        new Uint8Array(pixels.data.buffer),
        bitmap.width,
        bitmap.height,
        1,
      );
    } finally {
      bitmap.close();
    }
    this.renderer.set_lod_draw_tiles(new Int32Array());
    this.schedulePoll();
  }
  private roots() {
    return new Set(this.source.root.roots.map((r) => tileId(r.key)));
  }
  private touch(key: TileKey) {
    const item = this.residents.get(tileId(key));
    if (item) item.last = performance.now();
  }
  private ready(key: TileKey) {
    if (key.level === 0 && this.demand) {
      const active = this.activeHeightPlan,
        bounds = tileBounds(key);
      const halo = shadowBounds(
        {
          left: bounds[0],
          top: bounds[1],
          right: bounds[2],
          bottom: bounds[3],
        },
        this.source.root.bounds,
        this.source.root.height_range,
        this.demand.elevation,
        this.demand.azimuth,
        1,
      );
      if (
        !active ||
        active.level !== 0 ||
        !halo ||
        halo[0] < active.bounds[0] ||
        halo[1] < active.bounds[1] ||
        halo[2] > active.bounds[2] ||
        halo[3] > active.bounds[3]
      )
        return false;
    }
    return (
      this.residents.has(tileId(key)) &&
      this.renderer.lod_tile_ready(key.level, key.x, key.z)
    );
  }
  update(demand: MapDemand) {
    if (this.disposed || !this.renderer) return;
    const previous = this.demand;
    if (
      previous &&
      previous.scale === demand.scale &&
      previous.elevation === demand.elevation &&
      previous.azimuth === demand.azimuth &&
      previous.view.left === demand.view.left &&
      previous.view.top === demand.view.top &&
      previous.view.right === demand.view.right &&
      previous.view.bottom === demand.view.bottom
    )
      return;
    const now = performance.now(),
      x = (demand.view.left + demand.view.right) / 2,
      z = (demand.view.top + demand.view.bottom) / 2;
    if (this.previousCenter && now > this.previousCenter.time) {
      const dt = Math.max(16, now - this.previousCenter.time) / 1000;
      this.velocity = {
        x: (x - this.previousCenter.x) / dt,
        z: (z - this.previousCenter.z) / dt,
      };
    }
    if (
      !this.demand ||
      this.demand.scale !== demand.scale ||
      (this.previousCenter &&
        (Math.abs(x - this.previousCenter.x) >
          (demand.view.right - demand.view.left) / 2 ||
          Math.abs(z - this.previousCenter.z) >
            (demand.view.bottom - demand.view.top) / 2))
    )
      this.velocity = { x: 0, z: 0 };
    this.previousCenter = { x, z, time: now };
    this.demand = demand;
    this.refreshCut();
    this.schedule();
  }
  private schedule() {
    if (this.scheduled || this.disposed || document.hidden) return;
    this.scheduled = true;
    requestAnimationFrame(() => {
      this.scheduled = false;
      if (this.disposed || !this.demand || this.renderer.is_lost()) return;
      try {
        this.replan();
      } catch (error) {
        this.statusError = String(error);
      }
      if (this.changedContent || this.queue.length) this.redraw();
    });
  }
  private replan() {
    if (this.requiresReload) {
      this.jobs.update([]);
      this.refreshCut();
      return;
    }
    const d = this.demand!,
      root = this.source.root,
      maxLevel = root.roots[0].key.level;
    let level = desiredLevel(d.scale, this.level, maxLevel),
      plan: DemandPlan | undefined,
      height: HeightPlan | null = null;
    for (; level <= maxLevel; level++) {
      try {
        plan = planDemand(d.view, root.bounds, level, {
          maxTiles: 120,
          velocity: this.velocity,
        });
        if (!plan.tiles.length) break;
        if (!plan.bufferComplete && level < maxLevel) continue;
        const boxes = plan.tiles.map((t) => tileBounds(t.key));
        const bounds: Bounds = [
          Math.min(...boxes.map((b) => b[0])),
          Math.min(...boxes.map((b) => b[1])),
          Math.max(...boxes.map((b) => b[2])),
          Math.max(...boxes.map((b) => b[3])),
        ];
        height = planHeightWindow(
          bounds,
          root.bounds,
          root.height_range,
          level,
          d.elevation,
          d.azimuth,
          2 * 1024 * 1024,
        );
        if (height) break;
      } catch (error) {
        if (level === maxLevel) throw error;
      }
    }
    if (!plan || (plan.tiles.length && !height))
      throw Error("Unable to reserve minimum terrain coverage");
    this.level = Math.min(level, maxLevel);
    this.plan = plan;
    if (height && this.heightPlan) {
      const visible = plan.tiles
        .filter((t) => t.priority === "visible")
        .map((t) => tileBounds(t.key));
      if (visible.length) {
        const bounds: Bounds = [
          Math.min(...visible.map((b) => b[0])),
          Math.min(...visible.map((b) => b[1])),
          Math.max(...visible.map((b) => b[2])),
          Math.max(...visible.map((b) => b[3])),
        ];
        const required = planHeightWindow(
          bounds,
          root.bounds,
          root.height_range,
          level,
          d.elevation,
          d.azimuth,
          2 * 1024 * 1024,
        );
        // Keep the prepared guard window while it covers the view's complete
        // lighting footprint. Merely shifting a speculative ring needs no GPU
        // height rebuild or full resident reshade.
        if (required && coversPlan(this.heightPlan, required))
          height = this.heightPlan;
      }
    }
    if (
      height?.level !== this.heightPlan?.level ||
      String(height?.bounds) !== String(this.heightPlan?.bounds)
    )
      this.heightsDirty = true;
    this.heightPlan = height;
    const wanted = new Map<
      string,
      { key: TileKey; kind: "surface" | "height"; priority: number }
    >();
    for (const root of this.source.root.roots)
      wanted.set(tileId(root.key), {
        key: root.key,
        kind: "surface",
        priority: -100,
      });
    for (const t of plan.tiles) {
      const id = tileId(t.key);
      this.touch(t.key);
      if (!wanted.has(id))
        wanted.set(id, {
          key: t.key,
          kind: "surface",
          priority:
            (t.priority === "visible" ? 100 : 300) +
            Math.min(99, Math.sqrt(t.distance) / (128 * 2 ** level)),
        });
    }
    for (const key of height?.keys ?? []) {
      const id = tileId(key);
      const resident = this.residents.get(id);
      if (resident?.revision === root.revision && !this.heights.has(id)) {
        this.heights.set(id, {
          values: resident.heights,
          revision: root.revision,
          last: performance.now(),
          hash: resident.node.height.sha256,
        });
      }
      if (!wanted.has(id))
        wanted.set(id, { key, kind: "height", priority: 200 });
      else wanted.get(id)!.priority = Math.min(150, wanted.get(id)!.priority);
    }
    this.used = new Set(
      [...wanted.entries()]
        .filter(([, value]) => value.kind === "surface")
        .map(([id]) => id),
    );
    this.lastPanHit = plan.tiles
      .filter((t) => t.priority === "visible")
      .every((t) => this.ready(t.key));
    const jobs: TileJob<void>[] = [];
    let retryAt = Infinity;
    for (const { key, kind, priority } of wanted.values()) {
      const id = tileId(key),
        known =
          kind === "surface" ? this.residents.get(id) : this.heights.get(id);
      if (
        known?.revision === root.revision ||
        this.absent.get(id) === root.revision
      )
        continue;
      const job = this.job(key, kind, priority),
        error = this.errors.get(job.id);
      if (!error || performance.now() >= error.until) jobs.push(job);
      else retryAt = Math.min(retryAt, error.until);
    }
    const protectedHeights = new Set(height?.keys.map(tileId));
    for (const [id] of this.heights)
      if (!protectedHeights.has(id) && !this.residents.has(id))
        this.heights.delete(id);
    // Map entries whose arrays are already owned by residents have no second
    // allocation, but metadata is bounded too.
    while (this.heights.size > MAX_HEIGHT_PAGES) {
      const victim = [...this.heights].find(
        ([id]) => !protectedHeights.has(id),
      );
      if (!victim) break;
      this.heights.delete(victim[0]);
    }
    while (this.absent.size > 256)
      this.absent.delete(this.absent.keys().next().value!);
    this.jobs.update(jobs);
    if (Number.isFinite(retryAt)) {
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(
        () => {
          this.retryTimer = undefined;
          this.schedule();
        },
        Math.max(1, retryAt - performance.now()),
      );
    } else if (!jobs.length && !this.pollFailures) this.statusError = "";
    this.refreshCut();
  }
  private async loadCatalog(
    mask: Uint32Array | undefined,
    signal: AbortSignal,
  ) {
    if (!mask) return;
    const root = this.source.root;
    for (const i of catalogPagesForMask(mask, root.catalog)) {
      const ref = root.catalog[i],
        cached = this.catalog.get(i);
      if (cached?.hash === ref.sha256) continue;
      const materials = await this.source.catalog(i, signal);
      signal.throwIfAborted();
      materials.forEach((m, j) =>
        this.materialData.set(
          [
            ...m.uv,
            ...m.average,
            m.tint,
            Number(m.name.toLowerCase() === "sand"),
            0,
            0,
          ],
          (ref.start + j) * 12,
        ),
      );
      this.catalog.delete(i);
      this.catalog.set(i, { hash: ref.sha256, materials });
      while (this.catalog.size > 16)
        this.catalog.delete(this.catalog.keys().next().value!);
      this.renderer.update_materials(this.materialData);
      this.changedContent = true;
    }
  }
  private job(
    key: TileKey,
    kind: "surface" | "height",
    priority: number,
  ): TileJob<void> {
    const revision = this.source.root.revision,
      id = `${kind}:${tileId(key)}:${revision}`;
    return {
      id,
      priority,
      run: async (signal) => {
        const node = await this.source.at(key, signal);
        signal.throwIfAborted();
        const resident = this.residents.get(tileId(key));
        const previousHeight = this.heights.get(tileId(key));
        if (
          node &&
          kind === "height" &&
          previousHeight?.hash === node.height.sha256
        ) {
          previousHeight.revision = revision;
          this.heightsDirty = true;
          return;
        }
        if (
          node &&
          kind === "surface" &&
          resident?.node.data.sha256 === node.data.sha256
        ) {
          resident.node = node;
          resident.revision = revision;
          const heights = this.heights.get(tileId(key));
          if (heights && heights.hash === node.height.sha256)
            heights.revision = revision;
          this.heightsDirty = true;
          return;
        }
        const result: Result = { key, kind, node, revision };
        if (node) {
          const data = await this.decoder.load(
            node,
            kind,
            this.source.base,
            this.source.root.material_count,
            signal,
          );
          signal.throwIfAborted();
          await this.loadCatalog(data.materialMask, signal);
          Object.assign(result, {
            words: data.words,
            pick: data.pick,
            heights: data.heights,
          });
        }
        // An in-flight slot remains occupied until the next frame admits its
        // decoded result. Cached downloads cannot build an unbounded upload queue.
        await new Promise<void>((done) => {
          this.queue.push({ result, signal, done });
          this.redraw();
        });
      },
      complete: () => {
        this.errors.delete(id);
        this.schedule();
      },
      failed: (error) => {
        const previous = this.errors.get(id),
          attempts = (previous?.attempts ?? 0) + 1;
        this.errors.set(id, {
          attempts,
          until:
            performance.now() + Math.min(30000, 1000 * 2 ** (attempts - 1)),
          text: String(error),
        });
        while (this.errors.size > 512)
          this.errors.delete(this.errors.keys().next().value!);
        this.statusError =
          "Some terrain is delayed; showing available coverage";
        this.retryTimer ??= setTimeout(() => {
          this.retryTimer = undefined;
          this.schedule();
        }, 1000);
      },
    };
  }
  private evict(extra: number, protect: Set<string>) {
    const roots = this.roots();
    const candidates = [...this.residents.entries()]
      .filter(([id]) => !roots.has(id) && !protect.has(id))
      .sort((a, b) => a[1].last - b[1].last);
    while (
      (this.residents.size >= MAX_SURFACE_TILES ||
        this.chargedBytes + extra > MAP_CACHE_BYTES) &&
      candidates.length
    ) {
      const [id, r] = candidates.shift()!;
      this.renderer.remove_lod_tile(r.key.level, r.key.x, r.key.z);
      this.residents.delete(id);
    }
    return (
      this.residents.size < MAX_SURFACE_TILES &&
      this.chargedBytes + extra <= MAP_CACHE_BYTES
    );
  }
  private integrateOne() {
    const next = this.queue.shift();
    if (!next) return;
    try {
      if (
        next.signal.aborted ||
        next.result.revision !== this.source.root.revision
      )
        return;
      const { key, kind, node, revision } = next.result,
        id = tileId(key);
      const oldHeight = this.heights.get(id)?.hash;
      if (!node) {
        this.absent.set(id, revision);
        this.heights.set(id, {
          values: null,
          revision,
          last: performance.now(),
          hash: "absent",
        });
      } else if (kind === "height") {
        this.heights.set(id, {
          values: next.result.heights!,
          revision,
          last: performance.now(),
          hash: node.height.sha256,
        });
      } else {
        const existing = this.residents.has(id);
        if (!existing && !this.evict(TILE_BYTES, this.used)) return;
        this.renderer.add_lod_tile(key.level, key.x, key.z, next.result.words!);
        const previousPick = this.residents.get(id)?.pick;
        this.residents.set(id, {
          key,
          node,
          revision,
          pick:
            key.level > 0 && previousPick ? previousPick : next.result.pick!,
          pendingPick:
            key.level > 0 && previousPick ? next.result.pick! : undefined,
          heights: next.result.heights!,
          last: performance.now(),
        });
        this.heights.set(id, {
          values: next.result.heights!,
          revision,
          last: performance.now(),
          hash: node.height.sha256,
        });
        this.changedContent = true;
      }
      if (node && next.result.heights && oldHeight !== node.height.sha256)
        this.renderer.patch_lod_height(
          key.level,
          key.x,
          key.z,
          next.result.heights,
        );
      this.heightsDirty = true;
    } finally {
      next.done();
    }
  }
  // Called by the existing camera frame, after render() sets current sunlight.
  advance() {
    this.integrateOne();
    this.assembleHeights();
    const before = this.renderer.lod_pending_tiles();
    const remaining = this.renderer.prepare_lod_tiles(1);
    for (const r of this.residents.values()) {
      if (
        r.pendingPick &&
        !this.renderer.lod_tile_dirty(r.key.level, r.key.x, r.key.z)
      ) {
        r.pick = r.pendingPick;
        r.pendingPick = undefined;
      }
    }
    this.refreshCut();
    this.maxCharged = Math.max(this.maxCharged, this.chargedBytes);
    const draw = this.changedContent;
    this.changedContent = false;
    return this.queue.length > 0 || before > remaining || draw;
  }
  private assembleHeights() {
    const plan = this.heightPlan;
    if (!plan || !this.heightsDirty) return;
    const pages = new Map<string, Float32Array | null>();
    const hashes: string[] = [];
    for (const key of plan.keys) {
      const id = tileId(key),
        page = this.heights.get(id);
      if (!page || page.revision !== this.source.root.revision) return;
      pages.set(id, page.values);
      hashes.push(page.hash);
    }
    const signature = [plan.level, ...plan.bounds, ...hashes].join(":");
    this.heightsDirty = false;
    if (signature === this.windowSignature) return;
    const values = buildHeightWindow(plan, pages);
    const previous = this.renderer.height_bytes();
    // Height replacement allocates its new GPU maximum hierarchy before retiring
    // the old one; this transient fits the reserved working allowance.
    const newBytes = values.byteLength * 1.4 + 4096;
    if (!this.evict(Math.max(0, newBytes - previous), this.used)) return;
    this.renderer.set_height_window(
      new Int32Array(plan.bounds),
      values,
      plan.stride,
    );
    this.windowSignature = signature;
    this.activeHeightPlan = plan;
    this.changedContent = true;
  }
  private refreshCut() {
    if (!this.demand) return;
    const v = this.demand.view;
    const cut = buildDrawCut({
      roots: this.source.root.roots.map((r) => r.key),
      ready: [...this.residents.values()]
        .filter((r) => this.ready(r.key))
        .map((r) => r.key),
      worldBounds: this.source.root.bounds,
      viewport: [
        Math.floor(v.left),
        Math.floor(v.top),
        Math.ceil(v.right),
        Math.ceil(v.bottom),
      ],
      targetLevel: this.level,
    });
    const records = cut.flatMap((t) => [
      t.key.level,
      t.key.x,
      t.key.z,
      ...t.clip,
    ]);
    const signature = records.join(",");
    if (signature !== this.cutSignature) {
      this.renderer.set_lod_draw_cut(new Int32Array(records));
      this.cutSignature = signature;
      this.changedContent = true;
    }
    this.cut = cut;
    this.prepared = cut.length > 0;
    if (cut.some((t) => t.key.level > this.level)) this.framesWithFallback++;
  }
  pick(x: number, z: number) {
    const draw = pickDrawTile(this.cut, x, z);
    if (!draw) return null;
    const r = this.residents.get(tileId(draw.key))!;
    const stride = 2 ** draw.key.level,
      b = tileBounds(draw.key),
      ix =
        Math.floor((z - b[1]) / stride) * 128 + Math.floor((x - b[0]) / stride);
    const a = r.pick[ix * 2],
      c = r.pick[ix * 2 + 1];
    if (draw.key.level > 0) {
      const mean = (a << 16) >> 16,
        min = a >> 16,
        max = (c << 16) >> 16,
        flags = c >>> 16;
      if (!(flags & 1)) return null;
      return {
        height: mean / 16,
        name: "Approximate surface",
        detail: `${stride} × ${stride} blocks · height ${(min / 16).toFixed(1)}–${(max / 16).toFixed(1)}`,
      };
    }
    if (a === -32768) return null;
    const pageIndex = this.source.root.catalog.findIndex(
      (p) => c >= p.start && c < p.start + p.count,
    );
    const m =
      this.catalog.get(pageIndex)?.materials[
        c - this.source.root.catalog[pageIndex]?.start
      ];
    return {
      height: a / 16,
      name: m?.name.replaceAll("_", " ") ?? "Surface block",
      detail: m?.approximate ? "Top-surface approximation" : "",
    };
  }
  covered(x: number, z: number): boolean | null {
    const b = this.source.root.bounds;
    if (x < b[0] || x >= b[2] || z < b[1] || z >= b[3]) return false;
    return this.pick(x, z) ? true : null;
  }
  private schedulePoll() {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.disposed || document.hidden || this.requiresReload) return;
    this.pollTimer = setTimeout(
      () => void this.poll(),
      Math.min(30000, 2000 * 2 ** this.pollFailures),
    );
  }
  private async poll() {
    if (this.polling || this.disposed || document.hidden || this.requiresReload)
      return;
    this.polling = true;
    try {
      const old = this.source.root;
      const change = await this.source.refresh(AbortSignal.timeout(10000));
      if (change === "generation" || change === "appearance") {
        // Never mix coordinate/material epochs. A full reload is explicit and
        // keeps the already-drawn map visible until the operator retries.
        this.source.root = old;
        this.requiresReload = true;
        this.statusError =
          "Map generation or texture set changed. Reload the map.";
        this.jobs.update([]);
        this.redraw();
        return;
      }
      if (change === "revision") {
        const root = this.source.root;
        if (root.material_count < old.material_count)
          throw Error("Material IDs moved backwards");
        if (root.material_count !== old.material_count) {
          const next = new Float32Array(root.material_count * 12);
          next.set(this.materialData);
          this.materialData = next;
        }
        this.manifest.bounds = root.bounds;
        this.manifest.height_range = root.height_range;
        this.manifest.spawn = root.spawn;
        this.epoch++;
        this.errors.clear();
        this.schedule();
      }
      this.pollFailures = 0;
    } catch {
      this.pollFailures = Math.min(4, this.pollFailures + 1);
      this.statusError = "Terrain connection delayed";
    } finally {
      this.polling = false;
      this.schedulePoll();
    }
  }
  visibility() {
    if (document.hidden) {
      if (this.pollTimer) clearTimeout(this.pollTimer);
      this.jobs.update([]);
    } else {
      void this.poll();
      this.schedule();
    }
  }
  retry() {
    if (this.requiresReload) {
      location.reload();
      return;
    }
    this.errors.clear();
    this.statusError = "";
    void this.poll();
    this.schedule();
  }
  get memoryBytes() {
    let bytes = this.renderer?.gpu_bytes() ?? 0;
    bytes += this.materialData?.byteLength ?? 0;
    const buffers = new Set<ArrayBufferLike>();
    for (const r of this.residents.values()) {
      bytes += r.pick.byteLength;
      bytes += r.pendingPick?.byteLength ?? 0;
      buffers.add(r.heights.buffer);
    }
    for (const r of this.heights.values())
      if (r.values) buffers.add(r.values.buffer);
    for (const b of buffers) bytes += b.byteLength;
    return bytes + this.source.metadataBytes + this.catalog.size * 65536;
  }
  private get wasmBytes() {
    return (this.mainWasm?.buffer.byteLength ?? 0) + this.decoder.wasmBytes;
  }
  private get chargedBytes() {
    return (
      this.memoryBytes +
      RESERVE +
      Math.max(0, this.wasmBytes - 32 * 1024 * 1024)
    );
  }
  state() {
    return {
      level: this.level,
      stride: 2 ** this.level,
      cached: this.residents.size,
      pending: this.jobs.size,
      queued: this.queue.length,
      memory: this.memoryBytes,
      reserve: RESERVE + Math.max(0, this.wasmBytes - 32 * 1024 * 1024),
      wasmBytes: this.wasmBytes,
      highWater: this.maxCharged,
      metadataBytes: this.source.metadataBytes,
      workerWasm: this.decoder.wasmBytes,
      totalDecode: this.decoder.decodeMs,
      revision: this.source.root.revision,
      heightPages: this.heights.size,
      lastPanHit: this.lastPanHit,
      framesWithFallback: this.framesWithFallback,
      visible: this.plan?.visibleCount ?? 0,
      buffered: this.plan?.tiles.length ?? 0,
      error: this.statusError,
      failures: [...this.errors].map(([id, e]) => ({ id, message: e.text })),
      cut: this.cut.map((t) => ({ key: t.key, clip: t.clip })),
    };
  }
  cacheStats() {
    return objectCacheStats();
  }
  dispose() {
    this.disposed = true;
    this.jobs.dispose();
    this.decoder.dispose();
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    for (const item of this.queue) item.done();
    this.queue.length = 0;
  }
}
