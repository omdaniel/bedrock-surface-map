import init, { LodRenderer } from "../../pkg/surface_gpu.js";
import type { Material, Manifest, ObjectRef } from "../types";
import { MemoryLedger, MEMORY_LIMIT_BYTES } from "./memory";
import {
  desiredLevel,
  intersection,
  intersects,
  shadowBounds,
  viewTargetBounds,
  type Bounds,
} from "./selection";
import { LodDecoder } from "./decoder";
import { residentCut, coveringTile, cutAncestors } from "./cut";
import type { DecodeResult } from "./decoder.worker";
import {
  catalogAppendPages,
  changedChunks,
  chunkStamp,
  patchPicking,
  type ChunkRef,
} from "./live";
import {
  LodRootSource,
  ROOT_POLL_BYTES,
  readBytes,
  type LodFeedState,
} from "./root-source";
import {
  localAsset,
  catalogPagesForMask,
  parseCatalog,
  parseManifest,
  parseNode,
  tileBounds,
  tileId,
  type LodManifest,
  type LodNode,
  type NodeRef,
  type TileKey,
  MAX_INDEX_BYTES,
  MAX_TILE_BYTES,
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
  catalog: number[];
  chunks: Int32Array;
  absenceSource?: TileKey;
}
interface Demand {
  key: TileKey;
  ref: ObjectRef;
  kind: "index" | "detail" | "summary" | "height";
  priority: number;
  absenceSource?: TileKey;
}
interface PendingUpload {
  demand: Demand;
  result: DecodeResult;
  catalog: number[];
  node?: LodNode;
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
  root: LodManifest;
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
  private readonly catalogHashes = new Map<number, string>();
  private readonly gpuCatalogPages = new Set<number>();
  private readonly pendingCatalog = new Set<number>();
  private readonly demands = new Map<string, Demand>();
  private readonly edgeRequirements = new Map<string, TileKey>();
  private readonly edgeCache = new WeakMap<readonly TileKey[], TileKey[]>();
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
  private residencyRevision = 0;
  private cutStamp = "";
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private planTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private clock = 0;
  private mainWasm: WebAssembly.Memory;
  firstVisible: number | null = null;
  private readonly started = performance.now();
  private tileUploads = 0;
  private cancellations = 0;
  private live: LodRootSource | null = null;
  private rootChanged: (() => void) | null = null;
  private rebuildAppearance: (() => Promise<void>) | null = null;
  private adoptingRoot = false;
  private changingTree = false;
  private pendingRoot: {
    root: LodManifest;
    resolve: () => void;
    reject: (error: Error) => void;
  } | null = null;
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
      try {
        view.accountGpu();
        return view;
      } catch (error) {
        view.destroy();
        throw error;
      }
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
    return this.active !== null || this.upload !== null || this.adoptingRoot;
  }
  startLive(
    url: URL,
    changed: () => void,
    rebuild: () => Promise<void>,
    status: (state: LodFeedState) => void,
  ) {
    if (
      !this.root.world_id ||
      url.origin !== this.base.origin ||
      new URL(".", url).href !== this.base.href
    )
      throw Error("Invalid live LOD source");
    this.live?.destroy();
    this.rootChanged = changed;
    this.rebuildAppearance = rebuild;
    this.live = new LodRootSource(
      url,
      this.root,
      (root) =>
        new Promise<void>((resolve, reject) => {
          if (this.disposed) return reject(Error("LOD viewer stopped"));
          this.pendingRoot = { root, resolve, reject };
          // A submitted atomic replacement finishes before the root changes. A
          // canceled decoder retains its reservation until the worker acknowledges.
          if (this.active && !this.submittedUpload) this.active.abort.abort();
          void this.applyPendingRoot();
        }),
      () => this.ledger.tryReserve("root-poll", "transit", ROOT_POLL_BYTES),
      () => this.ledger.release("root-poll"),
      status,
      new URL("status", url),
    );
    this.live.visibility(!document.hidden);
  }
  private async applyPendingRoot() {
    if (!this.pendingRoot || this.active || this.adoptingRoot || this.disposed)
      return;
    const pending = this.pendingRoot;
    this.pendingRoot = null;
    this.adoptingRoot = true;
    try {
      const next = pending.root;
      const compare = catalogAppendPages(this.root, next);
      let compatible = compare !== null;
      if (compare?.length) {
        if (
          !this.ledger.tryReserve(
            "catalog-compare",
            "transit",
            MAX_INDEX_BYTES * 12,
          )
        )
          throw Error("LOD catalog validation awaits memory headroom");
        try {
          for (const { before, after } of compare) {
            const read = async (ref: typeof before) =>
              parseCatalog(
                JSON.parse(
                  new TextDecoder().decode(await readObject(ref, this.base)),
                ),
                ref.count,
              );
            const old = await read(before),
              newer = await read(after);
            if (
              old.some(
                (material, i) =>
                  JSON.stringify(material) !== JSON.stringify(newer[i]),
              )
            )
              compatible = false;
          }
        } finally {
          this.ledger.release("catalog-compare");
        }
      }
      if (this.disposed) throw Error("LOD viewer stopped");
      if (!compatible) {
        // Never shade old summaries with a changed descriptor or atlas. The
        // application releases this view before a coarse-first reconstruction.
        if (!this.rebuildAppearance)
          throw Error("LOD appearance requires reconstruction");
        await this.rebuildAppearance();
      } else {
        if (next.material_count > this.root.material_count) {
          if (
            !this.ledger.tryReserve(
              "catalog-grow",
              "retirement",
              next.material_count * 48,
            )
          )
            throw Error("LOD material growth awaits memory headroom");
          try {
            this.renderer.grow_materials(next.material_count);
          } finally {
            this.ledger.release("catalog-grow");
          }
        }
        for (const page of this.root.catalog) {
          if (
            next.catalog.find((p) => p.start === page.start)?.sha256 ===
            page.sha256
          )
            continue;
          // Prefix-compatible append keeps existing picking descriptors alive.
          // The page hash forces a reload before any new IDs use this page.
          this.gpuCatalogPages.delete(page.start);
        }
        this.root = next;
        this.changingTree = true;
        this.renderer.set_world(
          new Int32Array(next.bounds),
          next.height_range[1],
        );
        this.failed.clear();
        this.residencyRevision++;
        this.accountGpu();
        this.rootChanged?.();
      }
      pending.resolve();
    } catch (error) {
      pending.reject(error instanceof Error ? error : Error(String(error)));
    } finally {
      this.adoptingRoot = false;
      if (!this.disposed) this.plan();
    }
  }
  get stats() {
    const submission = this.renderer.submission_stats();
    return {
      memory: this.ledger.snapshot(),
      live: this.live
        ? {
            state: this.live.state,
            error: this.live.error,
            revision: this.root.revision,
            publication: this.live.publication,
          }
        : null,
      targetLevel: this.target,
      level: this.level,
      tiles: this.tiles.size,
      heights: this.heights.size,
      heightKeys: [...this.heights.keys()],
      projectedTiles: [...this.tiles.values()]
        .filter((tile) => tile.absenceSource)
        .map((tile) => ({
          key: tileId(tile.key),
          source: tileId(tile.absenceSource!),
        })),
      indexes: this.nodes.size,
      catalogPages: this.catalogPages.size,
      materialDescriptors: this.materials.size,
      pending: Number(this.busy),
      failures: [...this.failed.values()].map((v) => v.reason),
      firstVisible: this.firstVisible,
      mainWasmBytes: this.mainWasm.buffer.byteLength,
      workerWasmBytes: this.decoder.wasmBytes,
      decodeMs: this.decoder.decodeMs,
      tileUploads: this.tileUploads,
      cancellations: this.cancellations,
      cut: this.cut.map(tileId),
      previousCut: this.previousCut.map(tileId),
      edgeSources: [
        ...new Set(
          [
            ...this.edgeSources(this.cut),
            ...this.edgeSources(this.previousCut),
          ].map(tileId),
        ),
      ],
      retiringBytes: this.renderer.retiring_bytes(),
      gpuPending: this.renderer.pending_submissions(),
      gpuProgress: {
        submittedSerial: submission[0],
        completedSerial: submission[1],
        oldestInFlightAgeMs: submission[2],
        ageExact: submission[3] === 1,
      },
      preparations: this.renderer.pending_preparations(),
      activeKind: this.active?.demand.kind ?? null,
      queuedUpload: this.upload !== null || this.submittedUpload !== null,
      heightStatus: this.renderer.height_status(),
      logicalOccupancy: {
        surfaceBytes: [...this.tiles.values()].reduce(
          (sum, tile) => sum + this.renderer.tile_bytes(tile.key.level),
          0,
        ),
        pickingBytes: [...this.tiles.values()].reduce(
          (sum, tile) => sum + tile.pick.byteLength,
          0,
        ),
        heightSlots: this.heights.size,
        heightSlotCapacity: 128,
      },
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
  private shadowArea(level = this.target, area = this.bounds()): Bounds {
    const c = this.camera!,
      view = area,
      v = viewTargetBounds(
        { left: view[0], top: view[1], right: view[2], bottom: view[3] },
        this.root.bounds,
        level,
      );
    if (!v) return [0, 0, 0, 0];
    return (
      shadowBounds(
        { left: v[0], top: v[1], right: v[2], bottom: v[3] },
        this.root.bounds,
        c.shadows ? this.root.height_range : [0, 0],
        c.elevation,
        c.azimuth,
        Math.max(128, 2 ** level),
      ) ?? v
    );
  }
  private targetLevel(): number {
    const c = this.camera!,
      max = this.root.roots[0].key.level;
    let target = desiredLevel(c.scale * c.dpr, this.target, max);
    const visible = intersection(this.bounds(), this.root.bounds);
    const count = (area: Bounds | null, size: number) =>
      area
        ? (Math.ceil(area[2] / size) - Math.floor(area[0] / size)) *
          (Math.ceil(area[3] / size) - Math.floor(area[1] / size))
        : 0;
    const reclaimableTiles =
      (this.ledger.peek("gpu:surface")?.totalBytes ?? 0) +
      [...this.tiles.values()].reduce(
        (sum, tile) => sum + tile.pick.byteLength + tile.chunks.byteLength,
        0,
      );
    // Forecast a replacement, not a second copy of the job already reserved.
    // Actual admission still charges all current, pending and retiring resources.
    const activeJob =
      (this.ledger.peek("job")?.totalBytes ?? 0) +
      (this.ledger.peek("catalog-job")?.totalBytes ?? 0);
    const fixedCharge = Math.max(
      0,
      this.ledger.snapshot().totalBytes - reclaimableTiles - activeJob,
    );
    for (; target < max; target++) {
      const tileCost = (level: number) =>
        this.renderer.tile_bytes(level) + 131072;
      let surface = this.root.roots.length * tileCost(max);
      if (target < max)
        surface += count(visible, 128 * 2 ** target) * tileCost(target);
      if (target + 1 < max)
        surface +=
          count(visible, 128 * 2 ** (target + 1)) * tileCost(target + 1);
      let heightPages = 0;
      for (const level of new Set([target, Math.min(target + 1, max), max])) {
        const size = 128 * 2 ** level;
        heightPages +=
          level === max
            ? this.root.roots.length
            : count(
                intersection(this.shadowArea(level), this.root.bounds),
                size,
              );
      }
      // Roots, target detail and its immediate parents include sibling-transition
      // overlap. The ledger separately protects retirement and one maximum job.
      if (
        heightPages <= 96 &&
        surface + this.maximumTileJobBytes() <
          this.ledger.limitBytes - fixedCharge
      )
        break;
    }
    return target;
  }
  private maximumTileJobBytes() {
    return (
      MAX_TILE_BYTES * 2 +
      1024 * 1024 +
      Math.max(this.renderer.tile_bytes(0), this.renderer.tile_bytes(1)) +
      131072
    );
  }
  private plan(refine = false) {
    if (this.disposed || !this.camera || document.hidden) return;
    this.accountGpu();
    const next = this.targetLevel();
    if (next !== this.desiredTarget) {
      this.desiredTarget = next;
      clearTimeout(this.settleTimer);
      if (next < this.target)
        this.settleTimer = setTimeout(() => this.plan(true), 100);
    }
    if (refine || next >= this.target) this.target = next;
    this.demands.clear();
    const area = this.bounds();
    const surfaceTargets = new Map(
      this.root.roots.map((ref) => [tileId(ref.key), ref.key]),
    );
    for (const key of this.cut) {
      if (!intersects(tileBounds(key), area)) continue;
      surfaceTargets.set(tileId(key), key);
      if (key.level > this.target) {
        for (const child of this.nodes.get(tileId(key))?.node.children ?? [])
          if (intersects(tileBounds(child.key), area))
            surfaceTargets.set(tileId(child.key), child.key);
      } else if (key.level < this.target) {
        const factor = 2 ** (this.target - key.level);
        const parent = {
          level: this.target,
          x: Math.floor(key.x / factor),
          z: Math.floor(key.z / factor),
        };
        surfaceTargets.set(tileId(parent), parent);
      }
    }
    const footprints: (Bounds | null)[] = Array.from(
      { length: this.root.roots[0].key.level + 1 },
      () => null,
    );
    // Height residency follows drawable/refining surfaces, not every ancestor
    // whose metadata we traverse. Retiring cuts keep their own pages protected.
    for (const key of surfaceTargets.values()) {
      const area = this.shadowArea(key.level, tileBounds(key));
      const previous = footprints[key.level];
      footprints[key.level] = previous
        ? [
            Math.min(previous[0], area[0]),
            Math.min(previous[1], area[1]),
            Math.max(previous[2], area[2]),
            Math.max(previous[3], area[3]),
          ]
        : area;
    }
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
        casts =
          footprints[key.level] !== null &&
          intersects(footprints[key.level]!, box),
        descendants =
          key.level > this.target &&
          footprints
            .slice(this.target, key.level)
            .some((bounds) => bounds !== null && intersects(bounds, box));
      if (!root && !visible && !casts && !descendants) return;
      add(
        ref.index,
        key,
        "index",
        root ? 0 : 4 + (this.root.roots[0].key.level - key.level),
      );
      const stored = this.nodes.get(id);
      if (!stored || stored.hash !== ref.index.sha256) return;
      if (surfaceTargets.has(id))
        add(
          stored.node.data,
          key,
          key.level ? "summary" : "detail",
          root ? 1 : 30 - key.level,
        );
      if (root || casts)
        add(stored.node.height, key, "height", root ? 2 : 20 - key.level);
      if (key.level > this.target && (descendants || visible))
        for (const child of stored.node.children) visit(child);
    };
    for (const root of this.root.roots) visit(root, true);
    this.demandEdgeSources();
    this.evict();
    this.updateCut();
    this.demandEdgeSources();
    this.pairResidentUpdates();
    if (
      this.active &&
      !this.submittedUpload &&
      this.demands.get(this.active.id)?.ref.sha256 !==
        this.active.demand.ref.sha256
    ) {
      this.active.abort.abort();
      this.cancellations++;
    }
    for (const id of this.failed.keys())
      if (!this.demands.has(id)) this.failed.delete(id);
    void this.loadNext();
  }
  private pairResidentUpdates() {
    for (const [id, demand] of this.demands) {
      if (demand.kind !== "height") continue;
      const key = tileId(demand.key),
        resident = this.tiles.get(key);
      const node = this.nodes.get(key)?.node;
      if (
        !resident ||
        resident.absenceSource ||
        !node ||
        resident.hash === node.data.sha256
      )
        continue;
      // A displayed surface and its height page advance in one GPU submission.
      const kind = demand.key.level ? "summary" : "detail";
      const surfaceId = `${kind}:${key}`;
      const surface = this.demands.get(surfaceId);
      this.demands.set(surfaceId, {
        key: demand.key,
        kind,
        ref: node.data,
        priority: Math.min(demand.priority, surface?.priority ?? Infinity),
      });
      this.demands.delete(id);
    }
  }
  private schedulePlan() {
    if (this.planTimer !== undefined || this.disposed) return;
    this.planTimer = setTimeout(() => {
      this.planTimer = undefined;
      this.plan();
    }, 0);
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
    if (this.disposed || document.hidden || this.active || this.adoptingRoot)
      return;
    if (this.pendingRoot) {
      void this.applyPendingRoot();
      return;
    }
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
    const resident = this.tiles.get(tileId(demand.key));
    const updateNode =
      resident &&
      !demand.absenceSource &&
      (demand.kind === "detail" || demand.kind === "summary")
        ? this.nodes.get(tileId(demand.key))?.node
        : undefined;
    const chunks: ChunkRef[] | null =
      updateNode && resident
        ? changedChunks(resident.chunks, updateNode)
        : null;
    if (
      (demand.kind === "height" || updateNode) &&
      this.renderer.available_height_slots() === 0
    ) {
      this.evict(true);
      if (this.renderer.available_height_slots() === 0) {
        this.requestFrame();
        return;
      }
    }
    const reserve = updateNode
      ? ((chunks
          ? chunks.reduce((sum, chunk) => sum + chunk.bytes, 0)
          : updateNode.data.bytes) +
          updateNode.height.bytes) *
          2 +
        2 * 1024 * 1024 +
        this.renderer.surface_update_bytes(
          demand.key.level,
          chunks?.length ?? 0,
        ) +
        131072
      : demand.kind === "index"
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
        this.residencyRevision++;
      } else {
        const result = updateNode
          ? await this.decoder.update(
              updateNode,
              chunks,
              this.base,
              this.root.material_count,
              abort.signal,
            )
          : await this.decoder.load(
              demand.ref,
              demand.key,
              demand.kind,
              this.base,
              this.root.material_count,
              abort.signal,
              demand.absenceSource,
            );
        abort.signal.throwIfAborted();
        const catalog =
          demand.kind === "detail"
            ? await this.ensureMaterials(result.materialMask!, abort.signal)
            : [];
        abort.signal.throwIfAborted();
        await new Promise<void>((resolve, reject) => {
          this.upload = {
            demand,
            result,
            catalog,
            node: this.nodes.get(tileId(demand.key))?.node,
            resolve,
            reject,
          };
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
        if (/HTTP (404|410)/.test(String(error))) this.live?.refresh();
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => this.plan(), 2000);
      }
    } finally {
      this.ledger.release("job");
      this.pendingCatalog.clear();
      this.active = null;
      if (!this.disposed) {
        this.accountGpu();
        if (this.pendingRoot) void this.applyPendingRoot();
        else this.plan();
        this.requestFrame();
      }
    }
  }
  private async ensureMaterials(mask: Uint32Array, signal: AbortSignal) {
    const pages = this.root.catalog;
    const required = catalogPagesForMask(mask, pages);
    for (const index of required) this.pendingCatalog.add(pages[index].start);
    this.evictCatalog();
    for (const index of required) {
      const page = pages[index];
      if (
        this.catalogPages.has(page.start) &&
        this.catalogHashes.get(page.start) === page.sha256
      )
        continue;
      const capacity = page.bytes * 4 + page.count * 48;
      if (
        !this.ledger.tryReserve(
          "catalog-job",
          "transit",
          capacity + page.bytes * 2,
        )
      )
        throw Error("LOD catalog cannot fit alongside the active detail cut");
      try {
        const raw = await readObject(page, this.base, signal);
        const materials = parseCatalog(
          JSON.parse(new TextDecoder().decode(raw)),
          page.count,
        );
        signal.throwIfAborted();
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
        }
        if (!this.gpuCatalogPages.has(page.start)) {
          this.renderer.update_materials(page.start, data);
          this.gpuCatalogPages.add(page.start);
        }
        this.ledger.release("catalog-job");
        if (!this.ledger.set(`catalog:${page.start}`, "cpu", capacity))
          throw Error("LOD catalog memory limit");
        for (let i = 0; i < materials.length; i++)
          this.materials.set(page.start + i, materials[i]);
        this.catalogPages.add(page.start);
        this.catalogHashes.set(page.start, page.sha256);
      } finally {
        this.ledger.release("catalog-job");
      }
    }
    return [...required].map((index) => pages[index].start);
  }
  private evictCatalog() {
    const protectedPages = new Set(this.pendingCatalog);
    for (const resident of this.tiles.values())
      for (const start of resident.catalog) protectedPages.add(start);
    for (const page of this.root.catalog) {
      if (!this.catalogPages.has(page.start) || protectedPages.has(page.start))
        continue;
      for (let i = page.start; i < page.start + page.count; i++)
        this.materials.delete(i);
      this.catalogPages.delete(page.start);
      this.catalogHashes.delete(page.start);
      this.ledger.release(`catalog:${page.start}`);
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
      if (result.updateKind === "chunks") {
        this.renderer.patch_chunks(
          key.x,
          key.z,
          result.coordinates!,
          result.words!,
          result.heightWords!,
        );
      } else if (result.updateKind === "surface") {
        this.renderer.replace_surface(
          key.level,
          key.x,
          key.z,
          result.words!,
          result.heightWords!,
        );
      } else if (demand.kind === "height") {
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
        const previous = this.tiles.get(id);
        const pick =
          result.updateKind === "chunks" ? previous?.pick : result.pick;
        if (!pick) throw Error("LOD picking baseline missing");
        const chunks = chunkStamp(key.level ? [] : upload.node?.chunks);
        if (
          !this.ledger.set(
            `pick:${id}`,
            "cpu",
            pick.byteLength + chunks.byteLength,
          )
        )
          throw Error("LOD picking admission failed");
        if (result.updateKind === "chunks")
          patchPicking(pick, key, result.coordinates!, result.pick!);
        if (result.updateKind) {
          if (
            !upload.node ||
            !this.renderer.has_height(key.level, key.x, key.z)
          )
            throw Error("LOD replacement height was not prepared");
          this.heights.set(id, { key, hash: upload.node.height.sha256 });
        }
        this.tiles.set(id, {
          key,
          hash: demand.ref.sha256,
          pick,
          last: this.clock,
          catalog:
            result.updateKind === "chunks"
              ? [...new Set([...(previous?.catalog ?? []), ...upload.catalog])]
              : upload.catalog,
          chunks,
          absenceSource: demand.absenceSource,
        });
        this.tileUploads++;
      }
      this.accountGpu();
      this.residencyRevision++;
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
    const [total, retired, surfaces, heights, presentation, shared] =
      this.renderer.allocation_stats();
    if (total !== retired + surfaces + heights + presentation + shared)
      throw Error("LOD GPU allocation accounting mismatch");
    if (
      !this.ledger.setCapacities([
        { id: "gpu:surface", category: "surface", bytes: surfaces },
        { id: "gpu:height", category: "height", bytes: heights },
        { id: "gpu:shared", category: "atlas", bytes: shared },
        {
          id: "gpu:presentation",
          category: "presentation",
          bytes: presentation,
        },
        { id: "gpu-retired", category: "retirement", bytes: retired },
      ])
    )
      throw Error("LOD GPU resources exceed admitted memory");
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
  private renderReady(key: TileKey): boolean {
    if (!this.tiles.has(tileId(key))) return false;
    const heights = this.referenceCut(
      key.level,
      this.shadowArea(key.level, tileBounds(key)),
    );
    return (
      heights !== null &&
      heights.every((height) => this.heights.has(tileId(height)))
    );
  }
  private edgeSources(cut: readonly TileKey[]): TileKey[] {
    if (!cut.length) return [];
    const cached = this.edgeCache.get(cut);
    if (cached) return cached;
    const boxes = cut.map(tileBounds);
    const left = Math.min(...boxes.map((box) => box[0]));
    const top = Math.min(...boxes.map((box) => box[1]));
    const right = Math.max(...boxes.map((box) => box[2]));
    const bottom = Math.max(...boxes.map((box) => box[3]));
    // Cover complete cut tiles so small pans cannot reveal an unrequested edge
    // between cached cut-selection updates. The virtual query canvas is bounded.
    const values = this.renderer.required_sources(
      new Float32Array(cut.flatMap((key) => [key.level, key.x, key.z])),
      (left + right) / 2,
      (top + bottom) / 2,
      128 / Math.max(right - left, bottom - top),
      128,
      128,
    );
    const result: TileKey[] = [];
    for (let i = 0; i < values.length; i += 3)
      result.push({ level: values[i], x: values[i + 1], z: values[i + 2] });
    this.edgeCache.set(cut, result);
    return result;
  }
  private demandEdgeSources() {
    const add = (
      key: TileKey,
      ref: ObjectRef,
      kind: Demand["kind"],
      absenceSource?: TileKey,
    ) => {
      const id = `${kind}:${tileId(key)}`;
      const existing = this.demands.get(id);
      this.demands.set(id, {
        key,
        ref,
        kind,
        absenceSource,
        priority: Math.min(
          existing?.priority ?? Infinity,
          kind === "index" ? 3 : 8,
        ),
      });
    };
    const visit = (
      ref: NodeRef,
      target: TileKey,
      area: Bounds,
      height: boolean,
    ) => {
      if (!intersects(tileBounds(ref.key), area)) return;
      add(ref.key, ref.index, "index");
      const stored = this.nodes.get(tileId(ref.key));
      if (!stored || stored.hash !== ref.index.sha256) return;
      if (ref.key.level === target.level || !stored.node.children.length) {
        if (height) add(ref.key, stored.node.height, "height");
        else if (ref.key.level === target.level)
          add(ref.key, stored.node.data, ref.key.level ? "summary" : "detail");
        else if (target.level > 0 && ref.key.level > target.level)
          // Terminal sparse summaries can certify absence at finer gutters.
          // The shared decoder rejects any present source cell before projection.
          add(target, stored.node.data, "summary", ref.key);
        return;
      }
      for (const child of stored.node.children)
        visit(child, target, area, height);
    };
    for (const key of this.edgeRequirements.values()) {
      const box = tileBounds(key);
      for (const root of this.root.roots) {
        visit(root, key, box, false);
        visit(root, key, this.shadowArea(key.level, box), true);
      }
    }
  }
  private updateCut() {
    if (!this.camera) return;
    const area = this.bounds();
    if (this.changingTree) {
      // A new index hash is not a loss of the resident terrain. Keep the
      // displayed cut while its replacement metadata arrives, so an exact
      // tile remains available for a chunk patch instead of being reloaded.
      if (
        this.cut.some(
          (key) =>
            intersects(tileBounds(key), area) &&
            this.referenceCut(
              key.level,
              this.shadowArea(key.level, tileBounds(key)),
            ) === null,
        )
      )
        return;
      this.changingTree = false;
    }
    const stamp = [
      Math.floor(area[0] / 128),
      Math.floor(area[1] / 128),
      Math.ceil(area[2] / 128),
      Math.ceil(area[3] / 128),
      this.target,
      this.camera.shadows,
      this.camera.elevation,
      this.camera.azimuth,
      this.residencyRevision,
    ].join(":");
    if (stamp === this.cutStamp) return;
    const roots = this.root.roots
      .map((ref) => ref.key)
      .filter((key) => intersects(tileBounds(key), area));
    if (!roots.every((key) => this.renderReady(key))) return;
    const currentReady = this.cut.every((key) => this.renderReady(key));
    // Finish an admitted sibling transition before starting another. A changed
    // shadow footprint can still require an immediate coarser replacement.
    if (
      this.previousCut.length &&
      currentReady &&
      performance.now() - this.transitionStart < 200
    )
      return;
    this.cutStamp = stamp;
    this.edgeRequirements.clear();
    const ready = new Map<string, boolean>();
    const isReady = (key: TileKey) => {
      const id = tileId(key);
      if (!ready.has(id)) ready.set(id, this.renderReady(key));
      return ready.get(id)!;
    };
    const sourcesReady = (cut: readonly TileKey[]) => {
      const sources = this.edgeSources(cut);
      for (const key of sources) this.edgeRequirements.set(tileId(key), key);
      return sources.every(isReady);
    };
    const options = {
      roots,
      bounds: area,
      focus: [this.camera.cx, this.camera.cz] as const,
      maxTiles: 64,
      targetLevel: this.target,
      children: (key: TileKey) =>
        this.nodes.get(tileId(key))?.node.children.map((ref) => ref.key),
      isReady,
    };
    let next = residentCut(options);
    if (!sourcesReady(next)) {
      // Keep displayed descendants while their replacement's edge dependencies
      // arrive. Newly visible areas fall back to roots, not uncovered old views.
      const retained = new Set([...this.cut, ...roots].map(tileId));
      next = residentCut({
        ...options,
        isReady: (key) => retained.has(tileId(key)) && isReady(key),
      });
      if (!sourcesReady(next)) next = roots;
      this.schedulePlan();
    }
    const signature = (cut: TileKey[]) => cut.map(tileId).sort().join(",");
    sourcesReady(next);
    if (signature(next) === signature(this.cut)) return;
    // A new camera/light footprint can invalidate fine shadows. Blend only
    // when the previous level's full dependency set is still available.
    this.previousCut = currentReady && sourcesReady(this.cut) ? this.cut : [];
    this.cut = next;
    this.level = Math.min(
      this.root.roots[0].key.level,
      ...next.map((key) => key.level),
    );
    this.transitionStart = performance.now();
    this.schedulePlan();
    this.requestFrame();
  }
  private evict(aggressive = false) {
    // Fading tiles still sample their parent caches even when new camera demand
    // no longer visits those ancestors.
    const displayed = [
      ...this.cut,
      ...this.previousCut,
      ...this.edgeSources(this.cut),
      ...this.edgeSources(this.previousCut),
      ...this.root.roots.map((r) => r.key),
    ];
    const protectedIndexes = cutAncestors(
      displayed,
      this.root.roots[0].key.level,
    );
    const protectedIds = new Set(displayed.map(tileId));
    const protectedHeights = new Set(protectedIds);
    for (const key of displayed) {
      const shadow = this.shadowArea(key.level, tileBounds(key));
      const required = this.referenceCut(key.level, shadow);
      for (const height of required ?? []) protectedHeights.add(tileId(height));
      // While indexes change, the displayed last-known cut still needs its old
      // shadow pages. Geometric protection does not retain a second index tree.
      if (required === null)
        for (const [id, height] of this.heights)
          if (
            height.key.level >= key.level &&
            intersects(tileBounds(height.key), shadow)
          )
            protectedHeights.add(id);
    }
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
      this.residencyRevision++;
      this.ledger.release(`pick:${id}`);
    }
    for (const [id, height] of this.heights) {
      if (protectedHeights.has(id) || this.demands.has(`height:${id}`))
        continue;
      this.renderer.remove_height(height.key.level, height.key.x, height.key.z);
      this.heights.delete(id);
      this.residencyRevision++;
    }
    for (const [id] of this.nodes) {
      if (this.nodes.size <= METADATA_LIMIT && !aggressive) break;
      if (!protectedIndexes.has(id) && !this.demands.has(`index:${id}`)) {
        this.nodes.delete(id);
        this.residencyRevision++;
        this.ledger.release(`index:${id}`);
      }
    }
    this.evictCatalog();
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
    if (progress < 1) {
      // Boundaries belong to a topology, not to the union of fading cuts. Shared
      // tiles may have different edge lighting in the two contributions.
      const entries = (cut: readonly TileKey[]) =>
        new Float32Array(cut.flatMap((key) => [key.level, key.x, key.z]));
      this.renderer.set_transition(
        entries(this.previousCut),
        entries(this.cut),
        progress,
      );
    } else {
      const cut = this.cut.length
        ? this.cut
        : this.root.roots
            .map((ref) => ref.key)
            .filter((key) => this.tiles.has(tileId(key)));
      this.renderer.set_cut(
        new Float32Array(cut.flatMap((key) => [key.level, key.x, key.z, 1])),
      );
    }
    const width = Math.round(camera.width * camera.dpr);
    const height = Math.round(camera.height * camera.dpr);
    const resizeBytes = this.renderer.resize_bytes(width, height);
    if (!this.ledger.tryReserve("resize", "retirement", resizeBytes))
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
      this.schedulePlan();
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
    const key = coveringTile(this.cut, x, z);
    if (key) {
      const level = key.level;
      const item = this.tiles.get(tileId(key));
      if (!item) return null;
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
    this.live?.refresh();
    this.plan();
  }
  visibility() {
    clearTimeout(this.retryTimer);
    this.live?.visibility(!document.hidden);
    if (document.hidden) {
      if (!this.submittedUpload) this.active?.abort.abort();
    } else this.plan();
  }
  destroy() {
    this.disposed = true;
    this.live?.destroy();
    this.pendingRoot?.reject(Error("LOD viewer stopped"));
    this.pendingRoot = null;
    this.active?.abort.abort();
    this.upload?.reject(Error("LOD viewer stopped"));
    this.upload = null;
    this.submittedUpload?.reject(Error("LOD viewer stopped"));
    this.submittedUpload = null;
    this.decoder.destroy();
    clearTimeout(this.settleTimer);
    clearTimeout(this.retryTimer);
    clearTimeout(this.planTimer);
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
