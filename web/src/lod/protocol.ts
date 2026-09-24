import type { Material, ObjectRef } from "../types";
import { rootForest } from "./selection.ts";

export const TILE_SIDE = 128;
export const TILE_CELLS = TILE_SIDE * TILE_SIDE;
export const MAX_TILE_BYTES = 2 * 1024 * 1024;
export const MAX_INDEX_BYTES = 64 * 1024;
export interface TileKey {
  level: number;
  x: number;
  z: number;
}
export interface NodeRef {
  key: TileKey;
  index: ObjectRef;
}
export interface LodNode {
  key: TileKey;
  data: ObjectRef;
  height: ObjectRef;
  children: NodeRef[];
  chunks?: (ObjectRef & { cx: number; cz: number })[];
}
export interface CatalogRef extends ObjectRef {
  start: number;
  count: number;
}
export interface LodManifest {
  kind: "surface-lod";
  format_version: 1;
  name: string;
  bounds: [number, number, number, number];
  spawn: [number, number, number];
  source_sha256: string;
  generation: string;
  world_id?: string;
  revision: number;
  appearance_version: string;
  height_range: [number, number];
  atlas: ObjectRef;
  material_count: number;
  catalog: CatalogRef[];
  roots: NodeRef[];
}

export const tileId = (key: TileKey) => `${key.level}/${key.x}/${key.z}`;
export const span = (key: TileKey) => TILE_SIDE * 2 ** key.level;
export function tileBounds(key: TileKey): [number, number, number, number] {
  const size = span(key);
  return [key.x * size, key.z * size, (key.x + 1) * size, (key.z + 1) * size];
}
function requireValue(condition: unknown, reason: string): asserts condition {
  if (!condition) throw Error(`Invalid LOD ${reason}`);
}
function record(value: unknown): asserts value is Record<string, unknown> {
  requireValue(
    value && typeof value === "object" && !Array.isArray(value),
    "object",
  );
}
const integer = (value: unknown, lo: number, hi: number): value is number =>
  Number.isSafeInteger(value) && Number(value) >= lo && Number(value) <= hi;
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;

export function localAsset(path: string, base: URL): string {
  const url = new URL(path, base);
  requireValue(
    url.origin === base.origin &&
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
    "asset origin",
  );
  return url.href;
}
export function parseRef(
  value: unknown,
  base: URL,
  maximum = MAX_TILE_BYTES,
): ObjectRef {
  record(value);
  requireValue(
    text(value.url, 512) &&
      /^[A-Za-z0-9_./-]+$/.test(value.url) &&
      value.url
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== ".."),
    "asset URL",
  );
  localAsset(value.url, base);
  requireValue(
    typeof value.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256),
    "asset hash",
  );
  requireValue(integer(value.bytes, 1, maximum), "asset size");
  return { url: value.url, sha256: value.sha256, bytes: value.bytes };
}
export function parseKey(value: unknown): TileKey {
  record(value);
  requireValue(integer(value.level, 0, 16), "tile level");
  requireValue(
    integer(value.x, -65536, 65535) && integer(value.z, -65536, 65535),
    "tile coordinates",
  );
  const key = { level: value.level, x: value.x, z: value.z };
  requireValue(
    tileBounds(key).every((v) => Math.abs(v) <= 8388608),
    "tile bounds",
  );
  return key;
}
export function parseNodeRef(value: unknown, base: URL): NodeRef {
  record(value);
  return {
    key: parseKey(value.key),
    index: parseRef(value.index, base, MAX_INDEX_BYTES),
  };
}
export function parseNode(
  value: unknown,
  expected: TileKey,
  base: URL,
): LodNode {
  record(value);
  const key = parseKey(value.key);
  requireValue(tileId(key) === tileId(expected), "node identity");
  requireValue(
    Array.isArray(value.children) &&
      value.children.length <= (key.level ? 4 : 0),
    "children",
  );
  const children = value.children.map((child) => parseNodeRef(child, base));
  const ids = new Set<string>();
  for (const child of children) {
    requireValue(
      child.key.level === key.level - 1 &&
        Math.floor(child.key.x / 2) === key.x &&
        Math.floor(child.key.z / 2) === key.z &&
        !ids.has(tileId(child.key)),
      "child identity",
    );
    ids.add(tileId(child.key));
  }
  const node: LodNode = {
    key,
    data: parseRef(value.data, base),
    height: parseRef(value.height, base),
    children,
  };
  if (value.chunks !== undefined) {
    requireValue(
      key.level === 0 &&
        Array.isArray(value.chunks) &&
        value.chunks.length <= 64,
      "chunk references",
    );
    const chunkIds = new Set<string>();
    node.chunks = value.chunks.map((chunk) => {
      record(chunk);
      requireValue(
        integer(chunk.cx, -524288, 524287) &&
          integer(chunk.cz, -524288, 524287) &&
          Math.floor(chunk.cx / 8) === key.x &&
          Math.floor(chunk.cz / 8) === key.z,
        "chunk coordinates",
      );
      const id = `${chunk.cx}/${chunk.cz}`;
      requireValue(!chunkIds.has(id), "duplicate chunk");
      chunkIds.add(id);
      return { ...parseRef(chunk, base), cx: chunk.cx, cz: chunk.cz };
    });
  }
  return node;
}
export function parseManifest(value: unknown, base: URL): LodManifest {
  record(value);
  requireValue(
    value.kind === "surface-lod" && value.format_version === 1,
    "format",
  );
  requireValue(value.appearance_version === "1", "appearance version");
  requireValue(
    text(value.name, 256) &&
      text(value.generation, 128) &&
      text(value.appearance_version, 128),
    "identity",
  );
  requireValue(
    value.world_id === undefined || text(value.world_id, 80),
    "world identity",
  );
  requireValue(integer(value.revision, 0, Number.MAX_SAFE_INTEGER), "revision");
  requireValue(
    typeof value.source_sha256 === "string" &&
      /^[a-f0-9]{64}$/.test(value.source_sha256),
    "source fingerprint",
  );
  requireValue(
    Array.isArray(value.bounds) &&
      value.bounds.length === 4 &&
      value.bounds.every((v) => integer(v, -8388608, 8388608)) &&
      value.bounds[0] < value.bounds[2] &&
      value.bounds[1] < value.bounds[3],
    "bounds",
  );
  requireValue(
    Array.isArray(value.spawn) &&
      value.spawn.length === 3 &&
      value.spawn.every(Number.isFinite),
    "spawn",
  );
  requireValue(
    Array.isArray(value.height_range) &&
      value.height_range.length === 2 &&
      value.height_range.every((v) => integer(v, -32767, 32767)) &&
      value.height_range[0] <= value.height_range[1],
    "height range",
  );
  requireValue(integer(value.material_count, 1, 65536), "material count");
  requireValue(
    Array.isArray(value.catalog) && value.catalog.length <= 256,
    "catalog pages",
  );
  let cursor = 0;
  const catalog = value.catalog.map((item) => {
    record(item);
    requireValue(
      item.start === cursor && integer(item.count, 1, 256),
      "catalog page range",
    );
    cursor += item.count;
    return {
      ...parseRef(item, base, MAX_INDEX_BYTES),
      start: item.start as number,
      count: item.count,
    };
  });
  requireValue(cursor === value.material_count, "catalog coverage");
  requireValue(
    Array.isArray(value.roots) &&
      value.roots.length > 0 &&
      value.roots.length <= 4,
    "roots",
  );
  const roots = value.roots.map((root) => parseNodeRef(root, base));
  requireValue(
    new Set(roots.map((r) => tileId(r.key))).size === roots.length &&
      roots.every((r) => r.key.level === roots[0].key.level),
    "root levels",
  );
  const expected = rootForest(value.bounds as LodManifest["bounds"]).map(
    tileId,
  );
  requireValue(
    roots.length === expected.length &&
      roots.every((root) => expected.includes(tileId(root.key))),
    "root coverage",
  );
  return {
    kind: "surface-lod",
    format_version: 1,
    name: value.name,
    generation: value.generation,
    world_id: value.world_id as string | undefined,
    revision: value.revision,
    source_sha256: value.source_sha256,
    appearance_version: value.appearance_version,
    bounds: value.bounds as LodManifest["bounds"],
    spawn: value.spawn as LodManifest["spawn"],
    height_range: value.height_range as LodManifest["height_range"],
    atlas: parseRef(value.atlas, base, 32 * 1024 * 1024),
    material_count: value.material_count,
    catalog,
    roots,
  };
}
export function parseCatalog(value: unknown, count: number): Material[] {
  requireValue(
    Array.isArray(value) && value.length === count,
    "catalog length",
  );
  return value.map((m) => {
    record(m);
    requireValue(
      text(m.key, 4096) &&
        text(m.name, 1024) &&
        text(m.texture, 1024) &&
        integer(m.tint, 0, 3) &&
        typeof m.approximate === "boolean" &&
        Array.isArray(m.uv) &&
        m.uv.length === 4 &&
        m.uv.every((v) => Number.isFinite(v) && v >= 0 && v <= 1) &&
        m.uv[0] + m.uv[2] <= 1.000001 &&
        m.uv[1] + m.uv[3] <= 1.000001 &&
        Array.isArray(m.average) &&
        m.average.length === 4 &&
        m.average.every((v) => Number.isFinite(v) && v >= 0 && v <= 1),
      "material descriptor",
    );
    return m as unknown as Material;
  });
}
