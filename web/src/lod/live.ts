import type { LodManifest, LodNode, TileKey } from "./protocol.ts";

export type ChunkRef = NonNullable<LodNode["chunks"]>[number];

/** A bounded resident revision table, independent of evictable JSON indexes. */
export function chunkStamp(chunks: readonly ChunkRef[] = []): Int32Array {
  const words = new Int32Array(chunks.length * 10);
  chunks.forEach((chunk, i) => {
    words[i * 10] = chunk.cx;
    words[i * 10 + 1] = chunk.cz;
    for (let j = 0; j < 8; j++)
      words[i * 10 + 2 + j] = parseInt(
        chunk.sha256.slice(j * 8, j * 8 + 8),
        16,
      );
  });
  return words;
}

/** Removed references or absent baselines require a complete authoritative tile. */
export function changedChunks(
  stamp: Int32Array,
  node: LodNode,
): ChunkRef[] | null {
  if (node.key.level || !stamp.length || !node.chunks?.length) return null;
  const remaining = new Map<string, number>();
  for (let i = 0; i < stamp.length; i += 10)
    remaining.set(`${stamp[i]}/${stamp[i + 1]}`, i);
  const changed: ChunkRef[] = [];
  for (const chunk of node.chunks) {
    const id = `${chunk.cx}/${chunk.cz}`;
    const start = remaining.get(id);
    remaining.delete(id);
    if (
      start === undefined ||
      Array.from({ length: 8 }, (_, i) => i).some(
        (i) =>
          stamp[start + 2 + i] >>> 0 !==
          parseInt(chunk.sha256.slice(i * 8, i * 8 + 8), 16),
      )
    )
      changed.push(chunk);
  }
  return remaining.size || !changed.length ? null : changed;
}

/** Commit picking in the same turn that submits the matching GPU replacement. */
export function patchPicking(
  target: Int32Array,
  key: TileKey,
  coordinates: Int32Array,
  values: Int32Array,
): void {
  if (
    key.level !== 0 ||
    target.length !== 128 * 128 * 2 ||
    coordinates.length % 2 ||
    coordinates.length < 2 ||
    coordinates.length > 128 ||
    values.length !== (coordinates.length / 2) * 256 * 2
  )
    throw Error("Invalid LOD picking patch");
  const seen = new Set<string>();
  for (let i = 0; i < coordinates.length; i += 2) {
    const cx = coordinates[i],
      cz = coordinates[i + 1],
      id = `${cx}/${cz}`;
    if (
      Math.floor(cx / 8) !== key.x ||
      Math.floor(cz / 8) !== key.z ||
      seen.has(id)
    )
      throw Error("Invalid LOD picking patch coordinates");
    seen.add(id);
  }
  for (let i = 0; i < coordinates.length; i += 2) {
    const x = (coordinates[i] - key.x * 8) * 16;
    const z = (coordinates[i + 1] - key.z * 8) * 16;
    for (let row = 0; row < 16; row++) {
      const start = (i / 2) * 512 + row * 32;
      target.set(values.subarray(start, start + 32), ((z + row) * 128 + x) * 2);
    }
  }
}

export function assertLiveRevision(current: LodManifest, next: LodManifest) {
  if (!current.world_id || next.world_id !== current.world_id)
    throw Error("LOD world binding changed");
  if (next.generation !== current.generation)
    throw Error("LOD generation changed; update the explicit viewer binding");
  if (next.revision < current.revision)
    throw Error("LOD revision moved backwards");
}

/** Unchanged pages are free; a growing final page needs a prefix comparison. */
export function catalogAppendPages(current: LodManifest, next: LodManifest) {
  if (
    current.atlas.sha256 !== next.atlas.sha256 ||
    current.appearance_version !== next.appearance_version ||
    next.material_count < current.material_count
  )
    return null;
  const compare: {
    before: LodManifest["catalog"][number];
    after: LodManifest["catalog"][number];
  }[] = [];
  for (const before of current.catalog) {
    const after = next.catalog.find((page) => page.start === before.start);
    if (!after || after.count < before.count) return null;
    if (before.sha256 === after.sha256 && before.count === after.count)
      continue;
    if (
      before.start + before.count !== current.material_count ||
      after.count <= before.count
    )
      return null;
    compare.push({ before, after });
  }
  return compare;
}
