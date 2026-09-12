import type {
  DecodeRequest,
  Manifest,
  Material,
  ObjectRef,
  RegionRef,
} from "./types";
import { boundedBytes } from "./http";

export interface LiveRoot {
  format_version: 2;
  world_id: string;
  generation: string;
  revision: number;
  rules_version: number;
  name: string;
  bounds: number[];
  spawn: number[];
  source_sha256: string;
  catalog: ObjectRef;
  atlas: ObjectRef;
  height_range: number[];
  regions: {
    rx: number;
    rz: number;
    index: ObjectRef;
    surface: ObjectRef;
    heights: ObjectRef;
    columns: number;
  }[];
}
interface RegionIndex {
  rx: number;
  rz: number;
  chunks: Record<string, ObjectRef>;
}
export interface View {
  left: number;
  right: number;
  top: number;
  bottom: number;
}
type Decode = (
  request: Omit<DecodeRequest, "id">,
) => Promise<Uint32Array | Float32Array>;
export interface ChunkPatch {
  cx: number;
  cz: number;
  words: Uint32Array;
}
export interface TerrainUpdate {
  root: LiveRoot;
  manifest: Manifest;
  etag: string | null;
  patches: ChunkPatch[];
  replacements: { ref: RegionRef; words: Uint32Array }[];
  window: number[];
  heights?: Float32Array;
  heightPatches: { rx: number; rz: number; values: Float32Array }[];
  pages: Map<string, { sha: string; data: Int16Array }>;
}
const key = (r: { rx: number; rz: number }) => `${r.rx},${r.rz}`;
const equal = (a: number[], b: number[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);
const count = (b: number[]) => (b[2] - b[0]) * (b[3] - b[1]);
const validId = (s: unknown) =>
  typeof s === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(s);
function reference(r: ObjectRef) {
  if (
    !r ||
    !/^[a-f0-9]{64}$/.test(r.sha256) ||
    !Number.isSafeInteger(r.bytes) ||
    r.bytes < 0 ||
    r.bytes > 32 * 1024 * 1024 ||
    !new RegExp(`^objects/${r.sha256}\\.(zst|json|png)$`).test(r.url)
  )
    throw Error("Invalid terrain object reference");
}
export function validateRoot(root: LiveRoot) {
  if (
    root.format_version !== 2 ||
    root.rules_version !== 1 ||
    !validId(root.world_id) ||
    !validId(root.generation) ||
    !Number.isSafeInteger(root.revision) ||
    root.revision < 1 ||
    !Array.isArray(root.bounds) ||
    root.bounds.length !== 4 ||
    !root.bounds.every(
      (v) => Number.isInteger(v) && Math.abs(v) <= 8388608 && v % 256 === 0,
    ) ||
    root.bounds[2] <= root.bounds[0] ||
    root.bounds[3] <= root.bounds[1] ||
    !Array.isArray(root.regions) ||
    root.regions.length > 65536 ||
    !root.regions.length ||
    !Array.isArray(root.spawn) ||
    root.spawn.length !== 3 ||
    !root.spawn.every(Number.isFinite) ||
    !Array.isArray(root.height_range) ||
    root.height_range.length !== 2 ||
    !root.height_range.every(
      (v) => Number.isInteger(v) && v >= -1024 && v <= 5120,
    ) ||
    root.height_range[0] > root.height_range[1]
  )
    throw Error("Invalid live terrain manifest");
  reference(root.catalog);
  reference(root.atlas);
  const seen = new Set<string>();
  for (const r of root.regions) {
    if (
      !Number.isInteger(r.rx) ||
      !Number.isInteger(r.rz) ||
      r.rx * 256 < root.bounds[0] ||
      r.rz * 256 < root.bounds[1] ||
      r.rx * 256 + 256 > root.bounds[2] ||
      r.rz * 256 + 256 > root.bounds[3] ||
      seen.has(key(r))
    )
      throw Error("Invalid live region bounds");
    seen.add(key(r));
    reference(r.index);
    reference(r.surface);
    reference(r.heights);
  }
}
export class TerrainClient {
  readonly base: URL;
  root: LiveRoot;
  manifest!: Manifest;
  window: number[] = [];
  pages = new Map<string, { sha: string; data: Int16Array }>();
  etag: string | null = null;
  private indexes = new Map<string, RegionIndex>();
  changedChunks = 0;
  bytesReceived = 0;
  constructor(
    readonly url: URL,
    root: LiveRoot,
    private decode: Decode,
  ) {
    validateRoot(root);
    this.root = root;
    this.base = new URL(".", url);
  }
  asset(path: string) {
    const url = new URL(path, this.base);
    if (
      url.origin !== location.origin ||
      !url.pathname.startsWith(this.base.pathname)
    )
      throw Error("Terrain asset escaped its read endpoint");
    return url.href;
  }
  async checked<T>(ref: ObjectRef): Promise<T> {
    reference(ref);
    const response = await fetch(this.asset(ref.url), {
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok)
      throw Error(`Terrain object unavailable (${response.status})`);
    const bytes = await boundedBytes(response, ref.bytes);
    if (bytes.byteLength !== ref.bytes)
      throw Error("Terrain object length mismatch");
    const sha = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (v) => v.toString(16).padStart(2, "0"),
    ).join("");
    if (sha !== ref.sha256) throw Error("Terrain object checksum mismatch");
    this.bytesReceived += bytes.byteLength;
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  async normalize(root: LiveRoot): Promise<Manifest> {
    const materials =
      this.manifest?.catalog_version === root.catalog.sha256
        ? this.manifest.materials
        : await this.checked<Material[]>(root.catalog);
    if (
      !Array.isArray(materials) ||
      !materials.length ||
      materials.length > 65536 ||
      materials.some(
        (m) =>
          !m ||
          typeof m.name !== "string" ||
          !Array.isArray(m.uv) ||
          m.uv.length !== 4 ||
          !Array.isArray(m.average) ||
          m.average.length !== 4 ||
          ![...m.uv, ...m.average, m.tint].every(Number.isFinite),
      )
    )
      throw Error("Invalid live material catalog");
    return {
      format_version: 2,
      name: root.name,
      bounds: root.bounds,
      spawn: root.spawn,
      source_sha256: root.source_sha256,
      catalog_version: root.catalog.sha256,
      materials,
      atlas: root.atlas.url,
      regions: root.regions.map((r) => ({
        rx: r.rx,
        rz: r.rz,
        ...r.surface,
        columns: r.columns,
        index: r.index,
        heights: r.heights,
      })),
      heights: "",
      heights_sha256: "",
      height_range: root.height_range,
      approximations: [],
    };
  }
  async initialize() {
    this.manifest = await this.normalize(this.root);
    return this.manifest;
  }
  get memoryBytes() {
    return [...this.pages.values()].reduce((n, p) => n + p.data.byteLength, 0);
  }
  needed(view: View, elevation: number, root = this.root, padding = 0) {
    const halo =
      Math.ceil(
        (root.height_range[1] - root.height_range[0]) /
          16 /
          Math.tan((elevation * Math.PI) / 180),
      ) +
      2 +
      padding;
    const bounds = [
      Math.max(root.bounds[0], Math.floor((view.left - halo) / 256) * 256),
      Math.max(root.bounds[1], Math.floor((view.top - halo) / 256) * 256),
      Math.min(root.bounds[2], Math.ceil((view.right + halo) / 256) * 256),
      Math.min(root.bounds[3], Math.ceil((view.bottom + halo) / 256) * 256),
    ];
    if (bounds[0] >= bounds[2] || bounds[1] >= bounds[3]) {
      const x = Math.floor((view.left + view.right) / 512) * 256,
        z = Math.floor((view.top + view.bottom) / 512) * 256;
      return [x, z, x + 256, z + 256];
    }
    return bounds;
  }
  covers(view: View, elevation: number) {
    const needed = this.needed(view, elevation);
    return (
      this.window.length === 4 &&
      needed[0] >= this.window[0] &&
      needed[1] >= this.window[1] &&
      needed[2] <= this.window[2] &&
      needed[3] <= this.window[3]
    );
  }
  private async index(ref: ObjectRef) {
    let index = this.indexes.get(ref.sha256);
    if (!index) {
      index = await this.checked<RegionIndex>(ref);
      if (!index.chunks || Object.keys(index.chunks).length > 256)
        throw Error("Invalid terrain region index");
      for (const [coord, blob] of Object.entries(index.chunks)) {
        const [cx, cz] = coord.split(",").map(Number);
        if (
          !Number.isInteger(cx) ||
          !Number.isInteger(cz) ||
          Math.floor(cx / 16) !== index.rx ||
          Math.floor(cz / 16) !== index.rz
        )
          throw Error("Invalid indexed chunk");
        reference(blob);
      }
      this.indexes.set(ref.sha256, index);
      while (this.indexes.size > 256)
        this.indexes.delete(this.indexes.keys().next().value!);
    }
    return index;
  }
  async prepare(
    resident: Map<string, { ref: RegionRef }>,
    view: View,
    elevation: number,
    poll: boolean,
    availableHeightBytes: number,
  ): Promise<TerrainUpdate> {
    let root = this.root,
      etag = this.etag;
    if (poll) {
      const response = await fetch(this.url, {
        headers: etag ? { "If-None-Match": etag } : {},
        signal: AbortSignal.timeout(10000),
        cache: "no-cache",
      });
      if (response.status !== 304) {
        if (!response.ok)
          throw Error(`Terrain manifest unavailable (${response.status})`);
        const text = new TextDecoder().decode(
          await boundedBytes(response, 16 * 1024 * 1024),
        );
        root = JSON.parse(text);
        validateRoot(root);
        if (
          root.world_id !== this.root.world_id ||
          root.generation !== this.root.generation
        )
          throw Error("Terrain generation changed; reload required");
        if (root.revision < this.root.revision)
          throw Error("Older terrain revision rejected");
        etag = response.headers.get("etag");
      }
    }
    const manifest = await this.normalize(root);
    const requested = this.needed(view, elevation, root, 256);
    let window = this.window;
    const required = this.needed(view, elevation, root);
    if (
      !window.length ||
      required[0] < window[0] ||
      required[1] < window[1] ||
      required[2] > window[2] ||
      required[3] > window[3]
    )
      window = requested;
    if (count(window) <= 0)
      window = [
        Math.floor((view.left + view.right) / 512) * 256,
        Math.floor((view.top + view.bottom) / 512) * 256,
        Math.floor((view.left + view.right) / 512) * 256 + 256,
        Math.floor((view.top + view.bottom) / 512) * 256 + 256,
      ];
    const estimate = (bounds: number[]) =>
      count(bounds) * ((8 * 4) / 3 + 2) + 1024;
    if (estimate(window) > availableHeightBytes) window = required;
    if (
      count(window) <= 0 ||
      count(window) > 16 * 1024 * 1024 ||
      estimate(window) > availableHeightBytes
    )
      throw Error("Height coverage exceeds the 256 MiB cache. Zoom in.");
    const pages = new Map<string, { sha: string; data: Int16Array }>();
    const heightPatches: TerrainUpdate["heightPatches"] = [];
    for (const r of root.regions) {
      if (
        r.rx * 256 < window[0] ||
        r.rz * 256 < window[1] ||
        r.rx * 256 >= window[2] ||
        r.rz * 256 >= window[3]
      )
        continue;
      let page = this.pages.get(key(r));
      if (page?.sha !== r.heights.sha256) {
        const data = (await this.decode({
          kind: "heights",
          url: this.asset(r.heights.url),
          sha256: r.heights.sha256,
          columns: 65536,
        })) as Float32Array;
        page = {
          sha: r.heights.sha256,
          data: Int16Array.from(data, (v) =>
            v < -900000 ? -32768 : Math.round(v * 16),
          ),
        };
        heightPatches.push({ rx: r.rx, rz: r.rz, values: data });
        this.bytesReceived += r.heights.bytes;
      }
      pages.set(key(r), page);
    }
    let heights: Float32Array | undefined;
    if (!equal(window, this.window)) {
      const width = window[2] - window[0];
      heights = new Float32Array(count(window)).fill(-1e6);
      for (const [coord, page] of pages) {
        const [rx, rz] = coord.split(",").map(Number);
        const ox = rx * 256 - window[0],
          oz = rz * 256 - window[1];
        for (let z = 0; z < 256; z++)
          for (let x = 0; x < 256; x++) {
            const h = page.data[z * 256 + x];
            heights[(oz + z) * width + ox + x] = h === -32768 ? -1e6 : h / 16;
          }
      }
    }
    const patches: ChunkPatch[] = [],
      replacements: TerrainUpdate["replacements"] = [];
    for (const r of manifest.regions) {
      const cached = resident.get(key(r));
      if (!cached || cached.ref.sha256 === r.sha256) continue;
      try {
        if (!cached.ref.index || !r.index)
          throw Error("No previous chunk index");
        const previous = await this.index(cached.ref.index),
          next = await this.index(r.index);
        const staged: ChunkPatch[] = [];
        for (const [coord, ref] of Object.entries(next.chunks)) {
          if (previous.chunks[coord]?.sha256 === ref.sha256) continue;
          const [cx, cz] = coord.split(",").map(Number);
          const words = (await this.decode({
            kind: "chunk",
            url: this.asset(ref.url),
            sha256: ref.sha256,
            rx: cx,
            rz: cz,
            materials: manifest.materials.length,
          })) as Uint32Array;
          staged.push({ cx, cz, words });
          this.bytesReceived += ref.bytes;
        }
        if (Object.keys(previous.chunks).some((k) => !next.chunks[k]))
          throw Error("Chunk coverage changed");
        patches.push(...staged);
      } catch {
        const words = (await this.decode({
          kind: "region",
          url: this.asset(r.url),
          sha256: r.sha256,
          rx: r.rx,
          rz: r.rz,
          materials: manifest.materials.length,
        })) as Uint32Array;
        replacements.push({ ref: r, words });
        this.bytesReceived += r.bytes;
      }
    }
    return {
      root,
      manifest,
      etag,
      patches,
      replacements,
      window,
      heights,
      heightPatches,
      pages,
    };
  }
  commit(update: TerrainUpdate) {
    this.root = update.root;
    this.manifest = update.manifest;
    this.etag = update.etag;
    this.window = update.window;
    this.pages = update.pages;
    this.changedChunks += update.patches.length;
  }
}
