import init, { LodRenderer } from "../../pkg/surface_gpu.js";
import type { Material, Manifest, ObjectRef } from "../types";
import { MemoryLedger, MEMORY_LIMIT_BYTES } from "./memory";
import {
  desiredLevel,
  estimateTileBytes,
  intersection,
  intersects,
  shadowBounds,
  type Bounds,
} from "./selection";
import { LodDecoder } from "./decoder";
import type { DecodeResult } from "./decoder.worker";
import {
  localAsset,
  parseCatalog,
  parseManifest,
  parseNode,
  tileBounds,
  tileId,
  span,
  type LodManifest,
  type LodNode,
  type NodeRef,
  type TileKey,
  MAX_INDEX_BYTES,
} from "./protocol";

export interface LodCamera {
  cx: number;
  cz: number;
  scale: number;
  width: number;
  height: number;
  dpr: number;
  elevation: number;
  azimuth: number;
  shadows: boolean;
}
interface Resident {
  key: TileKey;
  hash: string;
  pick: Int32Array;
  last: number;
}
interface Demand {
  key: TileKey;
  ref: ObjectRef;
  kind: "index" | "detail" | "summary" | "height";
  priority: number;
}
interface PendingUpload {
  demand: Demand;
  result: DecodeResult;
  resolve: () => void;
  reject: (error: Error) => void;
}
const signed16 = (value: number) => (value << 16) >> 16;
const GPU_STARTUP_RESERVE = 24_000_000;
const METADATA_LIMIT = 512;

/** A bounded residency controller; camera ownership remains in the application. */
export class LodView {
  readonly ledger: MemoryLedger;
  readonly decoder = new LodDecoder();
  readonly base: URL;
  readonly root: LodManifest;
  readonly renderer: LodRenderer;
  private readonly requestFrame: () => void;
  private readonly notify: (status: string) => void;
  private readonly nodes = new Map<
    string,
    { node: LodNode; hash: string; bytes: number }
  >();
  private readonly tiles = new Map<string, Resident>();
  private readonly heights = new Map<string, { key: TileKey; hash: string }>();
  private readonly materials = new Map<number, Material>();
  private readonly catalogPages = new Set<number>();
  private readonly demands = new Map<string, Demand>();
  private readonly failed = new Map<
    string,
    { until: number; count: number; reason: string }
  >();
  private camera: LodCamera | null = null;
  private cameraStamp = "";
  private target = 0;
  private desiredTarget = 0;
  private level = 0;
  private active: {
    id: string;
    demand: Demand;
    abort: AbortController;
  } | null = null;
  private upload: PendingUpload | null = null;
  private submittedUpload: PendingUpload | null = null;
  private cut: TileKey[] = [];
  private previousCut: TileKey[] = [];
  private transitionStart = 0;
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private clock = 0;
  private mainWasm: WebAssembly.Memory;
  firstVisible: number | null = null;
  private readonly started = performance.now();
  private tileUploads = 0;
  private cancellations = 0;
  private readonly onRetired = () => {
    if (this.disposed) return;
    this.accountGpu();
    this.plan();
  };

  private constructor(
    root: LodManifest,
    base: URL,
    renderer: LodRenderer,
    memory: WebAssembly.Memory,
    ledger: MemoryLedger,
    requestFrame: () => void,
    notify: (status: string) => void,
  ) {
    this.root = root;
    this.base = base;
    this.renderer = renderer;
    this.mainWasm = memory;
    this.ledger = ledger;
    this.requestFrame = requestFrame;
    this.notify = notify;
    this.level = this.target = this.desiredTarget = root.roots[0].key.level;
    window.addEventListener("surface-lod-retired", this.onRetired);
  }

  static async create(
    url: URL,
    canvas: HTMLCanvasElement,
    requestFrame: () => void,
    notify: (status: string) => void,
    limit = MEMORY_LIMIT_BYTES,
  ) {
    if (url.origin !== location.origin)
      throw Error("LOD map must use the viewer origin");
    const ledger = new MemoryLedger(limit);
    const response = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      redirect: "error",
      cache: "no-cache",
    });
    const raw = await readBytes(response, MAX_INDEX_BYTES);
    const base = new URL(".", url);
    const root = parseManifest(JSON.parse(new TextDecoder().decode(raw)), base);
    if (!ledger.set("root", "cpu", MAX_INDEX_BYTES * 4 + 4096))
      throw Error("LOD root memory limit");
    const module = await init();
    if (!ledger.tryReserve("gpu-startup", "surface", GPU_STARTUP_RESERVE))
      throw Error("Minimum GPU height coverage cannot fit the map budget");
    // Atlas decoding is an explicitly reserved startup allocation, not hidden map residency.
    if (!ledger.tryReserve("atlas-startup", "transit", root.atlas.bytes))
      throw Error("Texture atlas cannot fit the configured map budget");
    const imageBytes = await readObject(root.atlas, base);
    const [width, height] = atlasDimensions(imageBytes);
    const decodedBytes = width * height * 4;
    if (
      !ledger.tryReserve(
        "atlas-startup",
        "transit",
        root.atlas.bytes +
          decodedBytes +
          Math.ceil((decodedBytes * 21) / 16) +
          root.material_count * 96 +
          1024 * 1024,
      )
    )
      throw Error("Decoded atlas cannot fit the configured map budget");
    const bitmap = await createImageBitmap(
      new Blob([imageBytes.buffer as ArrayBuffer]),
    );
    try {
      if (bitmap.width !== width || bitmap.height !== height)
        throw Error("Texture atlas dimensions changed during decode");
      const gpu = await LodRenderer.create(
        canvas,
        new Float32Array(root.material_count * 12),
        bitmap,
      );
      gpu.set_world(new Int32Array(root.bounds), root.height_range[1]);
      ledger.release("atlas-startup");
      ledger.release("gpu-startup");
      const view = new LodView(
        root,
        base,
        gpu,
        module.memory,
        ledger,
        requestFrame,
        notify,
      );
      view.accountGpu();
      return view;
    } finally {
      bitmap.close();
    }
  }

  get manifest(): Manifest {
    return {
      format_version: 1,
      name: this.root.name,
      bounds: this.root.bounds,
      spawn: this.root.spawn,
      source_sha256: this.root.source_sha256,
      catalog_version: this.root.appearance_version,
      materials: [],
      atlas: this.root.atlas.url,
      regions: [],
      heights: "",
      heights_sha256: "",
      height_range: this.root.height_range,
      approximations: ["Zoomed-out surface summaries are approximate"],
    };
  }
  get busy() {
    return this.active !== null || this.upload !== null;
  }
  get stats() {
    return {
      memory: this.ledger.snapshot(),
      targetLevel: this.target,
      level: this.level,
      tiles: this.tiles.size,
      heights: this.heights.size,
      indexes: this.nodes.size,
      pending: Number(this.busy),
      failures: [...this.failed.values()].map((v) => v.reason),
      firstVisible: this.firstVisible,
      mainWasmBytes: this.mainWasm.buffer.byteLength,
      workerWasmBytes: this.decoder.wasmBytes,
      decodeMs: this.decoder.decodeMs,
      tileUploads: this.tileUploads,
      cancellations: this.cancellations,
      cut: this.cut.map(tileId),
      retiringBytes: this.renderer.retiring_bytes(),
      gpuPending: this.renderer.pending_submissions(),
      preparations: this.renderer.pending_preparations(),
      activeKind: this.active?.demand.kind ?? null,
      queuedUpload: this.upload !== null || this.submittedUpload !== null,
      heightStatus: this.renderer.height_status(),
    };
  }
  setCamera(camera: LodCamera) {
    this.camera = camera;
    const stamp = JSON.stringify(camera);
    if (stamp === this.cameraStamp) return;
    this.cameraStamp = stamp;
    this.clock++;
    if (
      !this.ledger.set(
        "presentation",
        "presentation",
        Math.ceil(camera.width * camera.dpr) *
          Math.ceil(camera.height * camera.dpr) *
          4,
      )
    )
      throw Error("Canvas exceeds the map presentation budget");
    const target = this.targetLevel();
    if (target !== this.desiredTarget) {
      this.desiredTarget = target;
      clearTimeout(this.settleTimer);
      this.settleTimer = setTimeout(() => this.plan(true), 100);
    }
    this.plan();
  }
  private bounds(): Bounds {
    const c = this.camera!;
    return [
      c.cx - c.width / c.scale / 2,
      c.cz - c.height / c.scale / 2,
      c.cx + c.width / c.scale / 2,
      c.cz + c.height / c.scale / 2,
    ];
  }
  private shadowArea(): Bounds {
    const c = this.camera!,
      v = this.bounds();
    return (
      shadowBounds(
        { left: v[0], top: v[1], right: v[2], bottom: v[3] },
        this.root.bounds,
        c.shadows ? this.root.height_range : [0, 0],
        c.elevation,
        c.azimuth,
      ) ?? v
    );
  }
  private targetLevel(): number {
    const c = this.camera!,
      max = this.root.roots[0].key.level;
    let target = desiredLevel(c.scale * c.dpr, this.target, max);
    const visible = intersection(this.bounds(), this.root.bounds);
    const shadow = intersection(this.shadowArea(), this.root.bounds);
    const count = (area: Bounds | null, size: number) =>
      area
        ? (Math.ceil(area[2] / size) - Math.floor(area[0] / size)) *
          (Math.ceil(area[3] / size) - Math.floor(area[1] / size))
        : 0;
    const reclaimableTiles = [...this.tiles.values()].reduce((sum, tile) => {
      const bytes = estimateTileBytes(tile.key.level);
      return sum + bytes.surfaceBytes + bytes.shadeBytes + bytes.pickBytes;
    }, 0);
    const fixedCharge = Math.max(
      0,
      this.ledger.snapshot().totalBytes - reclaimableTiles,
    );
    for (; target < max; target++) {
      const size = 128 * 2 ** target,
        cost = estimateTileBytes(target);
      const detail =
        count(visible, size) *
        (cost.surfaceBytes + cost.pickBytes + cost.shadeBytes);
      const heights = count(shadow, size) * cost.heightBytes;
      // Parent overlap, transfer work and fixed resources are admitted before refinement.
      if (
        count(shadow, size) <= 96 &&
        detail * 1.5 + heights * 1.25 <
          Math.min(96_000_000, this.ledger.limitBytes - fixedCharge - 8_000_000)
      )
        break;
    }
    return target;
  }
  private plan(refine = false) {
    if (this.disposed || !this.camera || document.hidden) return;
    this.accountGpu();
    const next = this.targetLevel();
    if (refine || next >= this.target) this.target = next;
    this.demands.clear();
    const area = this.bounds(),
      shadow = this.shadowArea();
    const add = (
      ref: ObjectRef,
      key: TileKey,
      kind: Demand["kind"],
      priority: number,
    ) => {
      const id = `${kind}:${tileId(key)}`;
      this.demands.set(id, { ref, key, kind, priority });
    };
    const visit = (ref: NodeRef, root = false) => {
      const key = ref.key,
        id = tileId(key),
        box = tileBounds(key);
      const visible = intersects(area, box),
        casts = intersects(shadow, box);
      if (!root && !visible && !casts) return;
      add(
        ref.index,
        key,
        "index",
        root ? 0 : 4 + (this.root.roots[0].key.level - key.level),
      );
      const stored = this.nodes.get(id);
      if (!stored || stored.hash !== ref.index.sha256) return;
      if (root || visible)
        add(
          stored.node.data,
          key,
          key.level ? "summary" : "detail",
          root ? 1 : 30 - key.level,
        );
      if (root || (casts && key.level === this.target) || visible)
        add(stored.node.height, key, "height", root ? 2 : 20 - key.level);
      if (key.level > this.target)
        for (const child of stored.node.children) visit(child);
    };
    for (const root of this.root.roots) visit(root, true);
    if (this.active && !this.demands.has(this.active.id)) {
      this.active.abort.abort();
      this.cancellations++;
    }
    this.evict();
    this.updateCut();
    void this.loadNext();
  }
  private has(demand: Demand) {
    const id = tileId(demand.key);
    const record =
      demand.kind === "index"
        ? this.nodes.get(id)
        : demand.kind === "height"
          ? this.heights.get(id)
          : this.tiles.get(id);
    return record?.hash === demand.ref.sha256;
  }
  private async loadNext() {
    if (this.disposed || document.hidden || this.active) return;
    const wanted = [...this.demands.entries()]
      .filter(
        ([id, d]) =>
          !this.has(d) &&
          (this.failed.get(id)?.until ?? 0) <= performance.now(),
      )
      .sort((a, b) => a[1].priority - b[1].priority);
    const job = wanted[0];
    if (!job) return;
    const [id, demand] = job;
    const reserve =
      demand.kind === "index"
        ? demand.ref.bytes * 8 + 8192
        : demand.ref.bytes * 2 +
          1024 * 1024 +
          (demand.kind === "height"
            ? this.renderer.height_bytes(demand.key.level)
            : this.renderer.tile_bytes(demand.key.level) + 131072);
    if (!this.ledger.tryReserve("job", "transit", reserve)) {
      this.evict(true);
      if (!this.ledger.tryReserve("job", "transit", reserve)) return;
    }
    const abort = new AbortController();
    this.active = { id, demand, abort };
    try {
      if (demand.kind === "index") {
        const raw = await readObject(demand.ref, this.base, abort.signal);
        const node = parseNode(
          JSON.parse(new TextDecoder().decode(raw)),
          demand.key,
          this.base,
        );
        abort.signal.throwIfAborted();
        this.ledger.release("job");
        if (
          !this.ledger.set(
            `index:${tileId(demand.key)}`,
            "cpu",
            raw.byteLength * 4 + 1024,
          )
        )
          throw Error("LOD index admission failed");
        this.nodes.set(tileId(demand.key), {
          node,
          hash: demand.ref.sha256,
          bytes: raw.byteLength,
        });
      } else {
        const result = await this.decoder.load(
          demand.ref,
          demand.key,
          demand.kind,
          this.base,
          this.root.material_count,
          abort.signal,
        );
        abort.signal.throwIfAborted();
        if (demand.kind === "detail")
          await this.ensureMaterials(result.words!, abort.signal);
        await new Promise<void>((resolve, reject) => {
          this.upload = { demand, result, resolve, reject };
          this.requestFrame();
        });
      }
      this.failed.delete(id);
    } catch (error) {
      if (!abort.signal.aborted && !this.disposed) {
        const count = (this.failed.get(id)?.count ?? 0) + 1;
        this.failed.set(id, {
          count,
          reason: String(error),
          until:
            performance.now() + Math.min(30000, 1000 * 2 ** Math.min(count, 5)),
        });
        this.notify("Terrain detail delayed; retaining available coverage");
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => this.plan(), 2000);
      }
    } finally {
      this.ledger.release("job");
      this.active = null;
      if (!this.disposed) {
        this.accountGpu();
        this.plan();
        this.requestFrame();
      }
    }
  }
  private async ensureMaterials(words: Uint32Array, signal: AbortSignal) {
    const ids = new Set<number>();
    for (let i = 0; i < words.length; i += 8)
      for (const offset of [1, 3, 5]) ids.add(words[i + offset]);
    for (const page of this.root.catalog) {
      if (
        this.catalogPages.has(page.start) ||
        ![...ids].some((id) => id >= page.start && id < page.start + page.count)
      )
        continue;
      const raw = await readObject(page, this.base, signal);
      const materials = parseCatalog(
        JSON.parse(new TextDecoder().decode(raw)),
        page.count,
      );
      if (
        !this.ledger.set(
          `catalog:${page.start}`,
          "cpu",
          raw.byteLength * 4 + page.count * 48,
        )
      )
        throw Error("LOD catalog memory limit");
      const data = new Float32Array(page.count * 12);
      for (let i = 0; i < materials.length; i++) {
        const m = materials[i];
        data.set(
          [
            ...m.uv,
            ...m.average,
            m.tint,
            Number(m.name.toLowerCase() === "sand"),
            0,
            0,
          ],
          i * 12,
        );
        this.materials.set(page.start + i, m);
      }
      this.renderer.update_materials(page.start, data);
      this.catalogPages.add(page.start);
    }
  }
  private integrate() {
    const upload = this.upload;
    if (!upload || this.submittedUpload) return;
    this.upload = null;
    try {
      this.active?.abort.signal.throwIfAborted();
      const { demand, result } = upload,
        key = demand.key;
      if (demand.kind === "height") {
        this.renderer.add_height(key.level, key.x, key.z, result.words!);
      } else {
        this.renderer.add_tile(key.level, key.x, key.z, result.words!);
      }
      this.submittedUpload = upload;
    } catch (error) {
      upload.reject(error instanceof Error ? error : Error(String(error)));
    }
  }
  private finishUpload() {
    const upload = this.submittedUpload;
    if (!upload || this.renderer.pending_tiles() !== 0) return;
    this.submittedUpload = null;
    try {
      const { demand, result } = upload,
        key = demand.key,
        id = tileId(key);
      if (this.active?.abort.signal.aborted) {
        if (demand.kind === "height")
          this.renderer.remove_height(key.level, key.x, key.z);
        else this.renderer.remove_tile(key.level, key.x, key.z);
        this.active.abort.signal.throwIfAborted();
      }
      // The reservation remains charged through native allocation and submission.
      this.ledger.release("job");
      if (demand.kind === "height") {
        if (!this.renderer.has_height(key.level, key.x, key.z))
          throw Error("LOD height upload was not prepared");
        this.heights.set(id, { key, hash: demand.ref.sha256 });
      } else {
        if (!this.renderer.has_tile(key.level, key.x, key.z))
          throw Error("LOD tile upload was not prepared");
        if (!this.ledger.set(`pick:${id}`, "cpu", result.pick!.byteLength))
          throw Error("LOD picking admission failed");
        this.tiles.set(id, {
          key,
          hash: demand.ref.sha256,
          pick: result.pick!,
          last: this.clock,
        });
        this.tileUploads++;
      }
      this.accountGpu();
      upload.resolve();
    } catch (error) {
      upload.reject(error instanceof Error ? error : Error(String(error)));
    }
  }
  private accountGpu() {
    if (this.mainWasm.buffer.byteLength > 16 * 1024 * 1024)
      throw Error("LOD renderer exceeds its WASM memory allowance");
    this.ledger.observeWasm("main", this.mainWasm.buffer.byteLength);
    this.ledger.observeWasm("worker", this.decoder.wasmBytes);
    const retired = this.renderer.retiring_bytes();
    if (!this.ledger.set("gpu", "surface", this.renderer.gpu_bytes() - retired))
      throw Error("LOD GPU resources exceed admitted memory");
    if (!this.ledger.set("gpu-retired", "retirement", retired))
      throw Error("LOD retirement headroom exhausted");
  }
  private referenceCut(level: number, area: Bounds): TileKey[] | null {
    const output: TileKey[] = [];
    const visit = (ref: NodeRef): boolean => {
      if (!intersects(tileBounds(ref.key), area)) return true;
      const stored = this.nodes.get(tileId(ref.key));
      if (!stored || stored.hash !== ref.index.sha256) return false;
      if (ref.key.level <= level || !stored.node.children.length) {
        output.push(ref.key);
        return true;
      }
      return stored.node.children.every(visit);
    };
    return this.root.roots.every(visit) ? output : null;
  }
  private readyCut(level: number): TileKey[] | null {
    const cut = this.referenceCut(level, this.bounds());
    const heights = this.referenceCut(level, this.shadowArea());
    if (!cut || !heights) return null;
    if (
      !cut.every((key) => this.tiles.has(tileId(key))) ||
      !heights.every((key) => this.heights.has(tileId(key)))
    )
      return null;
    return cut;
  }
  private updateCut() {
    if (!this.camera) return;
    const max = this.root.roots[0].key.level;
    let next: TileKey[] | null = null,
      level = this.target;
    for (; level <= max; level++) {
      next = this.readyCut(level);
      if (next) break;
    }
    if (!next) return;
    const signature = (cut: TileKey[]) => cut.map(tileId).sort().join(",");
    if (signature(next) === signature(this.cut)) return;
    this.previousCut = this.cut;
    this.cut = next;
    this.level = level;
    this.transitionStart = performance.now();
    this.requestFrame();
  }
  private evict(aggressive = false) {
    const protectedIds = new Set(
      [
        ...this.cut,
        ...this.previousCut,
        ...this.root.roots.map((r) => r.key),
      ].map(tileId),
    );
    for (const [id, resident] of this.tiles) {
      if (
        protectedIds.has(id) ||
        this.demands.has(`${resident.key.level ? "summary" : "detail"}:${id}`)
      )
        continue;
      this.renderer.remove_tile(
        resident.key.level,
        resident.key.x,
        resident.key.z,
      );
      this.tiles.delete(id);
      this.ledger.release(`pick:${id}`);
    }
    for (const [id, height] of this.heights) {
      if (protectedIds.has(id) || this.demands.has(`height:${id}`)) continue;
      this.renderer.remove_height(height.key.level, height.key.x, height.key.z);
      this.heights.delete(id);
    }
    for (const [id] of this.nodes) {
      if (this.nodes.size <= METADATA_LIMIT && !aggressive) break;
      if (!protectedIds.has(id) && !this.demands.has(`index:${id}`)) {
        this.nodes.delete(id);
        this.ledger.release(`index:${id}`);
      }
    }
    this.accountGpu();
  }
  draw(
    camera: LodCamera,
    grid: boolean,
    strength: number,
    vivid: boolean,
    relief: number,
    reliefWidth: number,
  ) {
    this.setCamera(camera);
    this.integrate();
    this.updateCut();
    const progress =
      !this.previousCut.length ||
      matchMedia("(prefers-reduced-motion: reduce)").matches
        ? 1
        : Math.min(1, (performance.now() - this.transitionStart) / 200);
    const weighted = new Map<string, { key: TileKey; opacity: number }>();
    const append = (key: TileKey, opacity: number) => {
      const id = tileId(key);
      if (opacity > 0 && this.tiles.has(id))
        weighted.set(id, {
          key,
          opacity: Math.min(1, (weighted.get(id)?.opacity ?? 0) + opacity),
        });
    };
    if (!this.cut.length) for (const ref of this.root.roots) append(ref.key, 1);
    if (progress < 1)
      for (const key of this.previousCut) append(key, 1 - progress);
    for (const key of this.cut) append(key, progress);
    const entries = [...weighted.values()].flatMap(({ key, opacity }) => [
      key.level,
      key.x,
      key.z,
      opacity,
    ]);
    this.renderer.set_cut(new Float32Array(entries));
    const width = Math.round(camera.width * camera.dpr);
    const height = Math.round(camera.height * camera.dpr);
    const resizeBytes = this.renderer.resize_bytes(width, height);
    if (!this.ledger.tryReserve("resize", "surface", resizeBytes))
      throw Error("LOD presentation resize awaits resource retirement");
    let rendered = false;
    try {
      rendered = this.renderer.render(
        camera.cx,
        camera.cz,
        camera.scale * camera.dpr,
        width,
        height,
        grid,
        camera.shadows,
        camera.elevation,
        camera.azimuth,
        strength,
        vivid,
        relief,
        reliefWidth,
      );
    } catch (error) {
      this.submittedUpload?.reject(
        error instanceof Error ? error : Error(String(error)),
      );
      this.submittedUpload = null;
      throw error;
    } finally {
      this.ledger.release("resize");
    }
    this.finishUpload();
    this.accountGpu();
    if (
      this.submittedUpload ||
      !rendered ||
      this.renderer.pending_preparations()
    )
      this.requestFrame();
    if (rendered && this.cut.length && this.firstVisible === null)
      this.firstVisible = performance.now() - this.started;
    if (progress < 1) this.requestFrame();
    else if (this.previousCut.length) {
      this.previousCut = [];
      this.evict();
      if (this.renderer.pending_preparations()) this.requestFrame();
    }
    this.notify(
      this.busy
        ? "Loading terrain detail"
        : this.failed.size
          ? "Terrain detail delayed"
          : `LOD ${this.level} / ${this.tiles.size} tiles`,
    );
    return rendered;
  }
  inspect(
    x: number,
    z: number,
  ): { name: string; height: number; detail: string; present: boolean } | null {
    for (let level = 0; level <= this.root.roots[0].key.level; level++) {
      const size = 128 * 2 ** level,
        key = { level, x: Math.floor(x / size), z: Math.floor(z / size) };
      const item = this.tiles.get(tileId(key));
      if (!item) continue;
      const box = tileBounds(key),
        i =
          Math.floor((z - box[1]) / 2 ** level) * 128 +
          Math.floor((x - box[0]) / 2 ** level);
      const a = item.pick[i * 2],
        b = item.pick[i * 2 + 1];
      if (!level) {
        if (a === -32768)
          return {
            name: "No mapped surface",
            height: 0,
            detail: "",
            present: false,
          };
        const m = this.materials.get(b);
        return {
          name: m?.name.replaceAll("_", " ") ?? "Unresolved material",
          height: a / 16,
          detail: m?.approximate ? "Top-surface approximation" : "",
          present: true,
        };
      }
      if (!((b >>> 16) & 1))
        return {
          name: "No mapped surface",
          height: 0,
          detail: "Approximate coverage",
          present: false,
        };
      return {
        name: "Surface summary",
        height: signed16(a) / 16,
        detail: `Approximate / height ${signed16(a >>> 16) / 16} to ${signed16(b) / 16} / ${2 ** level} blocks per sample`,
        present: true,
      };
    }
    return null;
  }
  retry() {
    this.failed.clear();
    this.plan();
  }
  visibility() {
    clearTimeout(this.retryTimer);
    if (document.hidden) this.active?.abort.abort();
    else this.plan();
  }
  destroy() {
    this.disposed = true;
    this.active?.abort.abort();
    this.upload?.reject(Error("LOD viewer stopped"));
    this.upload = null;
    this.submittedUpload?.reject(Error("LOD viewer stopped"));
    this.submittedUpload = null;
    this.decoder.destroy();
    clearTimeout(this.settleTimer);
    clearTimeout(this.retryTimer);
    window.removeEventListener("surface-lod-retired", this.onRetired);
    this.renderer.free();
  }
}

function atlasDimensions(bytes: Uint8Array): [number, number] {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 33 || !signature.every((byte, i) => bytes[i] === byte))
    throw Error("LOD atlas is not PNG");
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (header.getUint32(8) !== 13 || header.getUint32(12) !== 0x49484452)
    throw Error("LOD atlas lacks PNG dimensions");
  const width = header.getUint32(16),
    height = header.getUint32(20);
  if (
    width < 4 ||
    height < 4 ||
    width > 8192 ||
    height > 8192 ||
    width * height > 8 * 1024 * 1024
  )
    throw Error("Texture atlas dimensions exceed map limits");
  return [width, height];
}

async function readBytes(
  response: Response,
  maximum: number,
  exact?: number,
): Promise<Uint8Array> {
  if (!response.ok || !response.body)
    throw Error(`LOD HTTP ${response.status}`);
  const length = Number(response.headers.get("content-length"));
  if (length > maximum || (exact !== undefined && length && length !== exact))
    throw Error("LOD response length limit");
  const buffer = new Uint8Array(exact ?? maximum);
  const reader = response.body.getReader();
  let offset = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (offset + value.length > buffer.length)
        throw Error("LOD response exceeds its reservation");
      buffer.set(value, offset);
      offset += value.length;
    }
    if (exact !== undefined && offset !== exact)
      throw Error("Truncated LOD response");
  } finally {
    await reader.cancel().catch(() => {});
  }
  return buffer.subarray(0, offset);
}
async function readObject(ref: ObjectRef, base: URL, signal?: AbortSignal) {
  const response = await fetch(localAsset(ref.url, base), {
    signal: AbortSignal.any([
      ...(signal ? [signal] : []),
      AbortSignal.timeout(10000),
    ]),
    redirect: "error",
  });
  const bytes = await readBytes(response, ref.bytes, ref.bytes);
  const digest = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer),
    ),
    (value) => value.toString(16).padStart(2, "0"),
  ).join("");
  if (digest !== ref.sha256) throw Error("LOD object checksum mismatch");
  return bytes;
}
