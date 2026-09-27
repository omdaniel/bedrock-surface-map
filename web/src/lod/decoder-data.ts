import type { ObjectRef } from "../types";
import {
  localAsset,
  MAX_TILE_BYTES,
  parseNode,
  parseRef,
  TILE_CELLS,
  type LodNode,
  type TileKey,
} from "./protocol.ts";

export type ChunkRef = NonNullable<LodNode["chunks"]>[number];
export interface DecodeObject {
  url: string;
  ref: ObjectRef;
}
export interface UpdatePlan {
  key: TileKey;
  materials: number;
  updateKind: "surface" | "chunks";
  height: DecodeObject;
  surface?: DecodeObject;
  chunks?: (DecodeObject & { cx: number; cz: number })[];
}
export const MAX_CHUNK_BYTES = 32768;
export const CHUNK_CELLS = 256;

export function validateMaterials(materials: number): void {
  if (!Number.isSafeInteger(materials) || materials < 1 || materials > 65536)
    throw Error("Invalid LOD material count");
}

/** Complete preflight before any worker dispatch or object download. */
export function prepareUpdate(
  value: LodNode,
  chunks: ChunkRef[] | null,
  base: URL,
  materials: number,
): UpdatePlan {
  validateMaterials(materials);
  const node = parseNode(value, value.key, base);
  const object = (ref: ObjectRef): DecodeObject => ({
    url: localAsset(ref.url, base),
    ref,
  });
  const plan: UpdatePlan = {
    key: node.key,
    materials,
    updateKind: chunks === null ? "surface" : "chunks",
    height: object(node.height),
  };
  if (chunks === null) {
    plan.surface = object(node.data);
    return plan;
  }
  if (
    node.key.level !== 0 ||
    !Array.isArray(chunks) ||
    chunks.length < 1 ||
    chunks.length > 64
  )
    throw Error("Invalid LOD update chunks");
  const seen = new Set<string>();
  let total = 0;
  plan.chunks = chunks.map((chunk) => {
    if (!chunk || typeof chunk !== "object")
      throw Error("Invalid LOD update chunk");
    const ref = parseRef(chunk, base, MAX_CHUNK_BYTES);
    const existing = node.chunks?.find(
      (entry) => entry.cx === chunk.cx && entry.cz === chunk.cz,
    );
    const id = `${chunk.cx}/${chunk.cz}`;
    if (
      !existing ||
      existing.url !== ref.url ||
      existing.sha256 !== ref.sha256 ||
      existing.bytes !== ref.bytes ||
      seen.has(id)
    )
      throw Error("Invalid LOD update chunk identity");
    seen.add(id);
    total += ref.bytes;
    if (total > MAX_TILE_BYTES) throw Error("LOD update transfer limit");
    return { ...object(ref), cx: existing.cx, cz: existing.cz };
  });
  return plan;
}

/** Shared by loads and updates so packed inspection fields cannot diverge. */
export function surfacePicking(
  words: Uint32Array,
  kind: "detail" | "summary",
  materials: number,
  cells = TILE_CELLS,
): { pick: Int32Array; materialMask?: Uint32Array } {
  validateMaterials(materials);
  if (
    !Number.isSafeInteger(cells) ||
    cells < 1 ||
    cells > TILE_CELLS ||
    words.length !== cells * (kind === "detail" ? 8 : 6)
  )
    throw Error("Invalid LOD decoded surface size");
  const pick = new Int32Array(cells * 2);
  const materialMask =
    kind === "detail" ? new Uint32Array(Math.ceil(materials / 32)) : undefined;
  for (let i = 0; i < cells; i++) {
    if (kind === "detail") {
      pick[i * 2] = words[i * 8 + 7] === 1 ? words[i * 8] : -32768;
      pick[i * 2 + 1] = words[i * 8 + 1];
      for (const offset of [1, 3, 5]) {
        const id = words[i * 8 + offset];
        if (id >= materials) throw Error("Invalid LOD decoded material");
        materialMask![id >>> 5] |= 1 << (id & 31);
      }
    } else {
      pick[i * 2] = words[i * 6 + 3];
      pick[i * 2 + 1] =
        (words[i * 6 + 4] & 0xffff) | (words[i * 6 + 5] & 0xffff0000);
    }
  }
  return { pick, materialMask };
}

/** Only one temporary native chunk is retained while assembling the flat patch. */
export function decodeChunkPatch(
  chunks: readonly { cx: number; cz: number }[],
  materials: number,
  decode: (index: number) => Uint32Array,
) {
  validateMaterials(materials);
  if (chunks.length < 1 || chunks.length > 64)
    throw Error("Invalid LOD update chunks");
  const words = new Uint32Array(chunks.length * CHUNK_CELLS * 8);
  const coordinates = new Int32Array(chunks.length * 2);
  chunks.forEach((chunk, i) => {
    const decoded = decode(i);
    if (decoded.length !== CHUNK_CELLS * 8)
      throw Error("Invalid LOD decoded chunk size");
    words.set(decoded, i * CHUNK_CELLS * 8);
    coordinates.set([chunk.cx, chunk.cz], i * 2);
  });
  return {
    words,
    coordinates,
    ...surfacePicking(words, "detail", materials, chunks.length * CHUNK_CELLS),
  };
}
