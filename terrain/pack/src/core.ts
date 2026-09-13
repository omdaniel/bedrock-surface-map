export type States = Record<string, string | number | boolean>;
export interface Material {
  name: string;
  states: States;
}
export interface Block {
  y: number;
  material: Material;
}
export type Column = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];
export interface Chunk {
  cx: number;
  cz: number;
  columns: Column[];
}
export interface Sample {
  materials: Material[];
  chunk: Chunk;
  start: number;
  end: number;
}
export interface Rules {
  version: number;
  canonical_state_defaults?: Record<string, States>;
  air: string[];
  water: string[];
  overlay: string[];
  overlay_contains: string[];
  biomes: Record<string, number>;
  tints: { ids: number[]; rgb: number }[];
  default_tint: number;
}
export interface Access {
  minimum: number;
  loaded(x: number, z: number): boolean;
  top(x: number, z: number): Block | undefined;
  block(x: number, y: number, z: number): Block | undefined;
  belowWater?(x: number, y: number, z: number): Block | undefined;
  biome(x: number, y: number, z: number): string;
}
export const UNKNOWN: Material = { name: "surface:unknown", states: {} };
export const empty = (): Column => [
  2, -32768, 0, 0xffffff, -1, 0, -32768, 0, 0, -32768,
];
const short = (name: string) => name.replace(/^minecraft:/, "");
export const materialKey = (m: Material) =>
  JSON.stringify([
    m.name,
    Object.fromEntries(
      Object.entries(m.states)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, typeof v === "boolean" ? Number(v) : v]),
    ),
  ]);
export function role(m: Material, rules: Rules) {
  const name = short(m.name);
  if (rules.air.includes(name)) return "air";
  if (rules.water.includes(name)) return "water";
  if (
    !name.includes("carpet") &&
    (rules.overlay.includes(name) ||
      rules.overlay_contains.some((s) => name.includes(s)))
  )
    return "overlay";
  return "primary";
}
export function height(b: Block) {
  const n = b.material.name,
    s = b.material.states;
  let fraction = 16;
  if (
    n.includes("slab") &&
    !n.includes("double") &&
    s.top_slot_bit !== true &&
    s.top_slot_bit !== 1 &&
    s["minecraft:vertical_half"] !== "top"
  )
    fraction = 8;
  if (n.endsWith(":snow_layer"))
    fraction = 2 * Math.max(1, Math.min(8, Number(s.height ?? 0) + 1));
  if (n.endsWith(":leaf_litter")) fraction = 1;
  return b.y * 16 + fraction;
}
export function* scan(
  access: Access,
  rules: Rules,
  cx: number,
  cz: number,
  now: () => number,
): Generator<void, Sample> {
  const start = now(),
    materials: Material[] = [UNKNOWN],
    ids = new Map([[materialKey(UNKNOWN), 0]]);
  const intern = (m: Material) => {
    m = { name: m.name, states: { ...m.states } };
    for (const [key, value] of Object.entries(
      rules.canonical_state_defaults?.[m.name] ?? {},
    ))
      if (m.states[key] === value) delete m.states[key];
    const half = m.states["minecraft:vertical_half"];
    const slot = m.states.top_slot_bit;
    if (
      m.name.includes("slab") &&
      ((half === "top" && (slot === 1 || slot === true)) ||
        (half === "bottom" && (slot === 0 || slot === false)))
    )
      delete m.states.top_slot_bit;
    const key = materialKey(m),
      existing = ids.get(key);
    if (existing !== undefined) return existing;
    const id = materials.length;
    materials.push(m);
    ids.set(key, id);
    return id;
  };
  const chunk: Chunk = { cx, cz, columns: [] };
  for (let z = 0; z < 16; z++)
    for (let x = 0; x < 16; x++) {
      const wx = cx * 16 + x,
        wz = cz * 16 + z;
      if (!access.loaded(wx, wz)) throw Error("unloaded");
      yield;
      let b = access.top(wx, wz);
      yield;
      if (!b) {
        chunk.columns.push(empty());
        continue;
      }
      let overlay: Block | undefined,
        water: Block | undefined,
        depth = 0,
        support: Block | undefined;
      for (let y = b.y; y >= access.minimum; y--) {
        if (!b || b.y !== y) {
          b = access.block(wx, y, wz);
          yield;
        }
        if (!b) throw Error("unavailable-block");
        const kind = role(b.material, rules);
        if (kind === "air") {
          if (water) depth++;
          continue;
        }
        if (kind === "water") {
          water ??= b;
          if (access.belowWater) {
            const next = access.belowWater(wx, y - 1, wz);
            yield;
            depth += y - (next?.y ?? access.minimum - 1);
            if (!next) break;
            y = next.y + 1;
            b = next;
            continue;
          }
          depth++;
          continue;
        }
        if (kind === "overlay" && !water) {
          overlay ??= b;
          continue;
        }
        support = b;
        break;
      }
      if (!support && !water) {
        if (overlay) throw Error("unsupported-floating-overlay");
        chunk.columns.push(empty());
        continue;
      }
      const top = water ?? support!;
      const name = access.biome(wx, (support ?? top).y, wz);
      yield;
      const biome = rules.biomes[short(name)] ?? -1;
      const tint =
        rules.tints.find((t) => t.ids.includes(biome))?.rgb ??
        rules.default_tint;
      chunk.columns.push([
        1,
        height(top),
        intern(top.material),
        tint,
        biome,
        overlay ? intern(overlay.material) : 0,
        overlay ? height(overlay) : -32768,
        water ? Math.min(depth, 255) : 0,
        support ? intern(support.material) : 0,
        support ? height(support) : -32768,
      ]);
    }
  if (!access.loaded(cx * 16, cz * 16)) throw Error("unloaded");
  yield;
  return { materials, chunk, start, end: now() };
}

type Work = {
  cx: number;
  cz: number;
  due: number;
  urgent: boolean;
  serial: number;
  marked: number;
};
export class WorkQueue {
  private entries = new Map<string, Work>();
  private serial = 0;
  overflow = 0;
  mark(cx: number, cz: number, due: number, urgent = false) {
    if (
      ![cx, cz].every((v) => Number.isInteger(v) && v >= -524288 && v < 524288)
    )
      return;
    const key = `${cx},${cz}`,
      old = this.entries.get(key);
    if (old) {
      old.due = Math.min(old.due, due);
      old.urgent ||= urgent;
      old.serial = ++this.serial;
      return;
    }
    if (this.entries.size >= 8192) {
      this.overflow++;
      return;
    }
    this.entries.set(key, {
      cx,
      cz,
      due,
      marked: due,
      urgent,
      serial: ++this.serial,
    });
  }
  take(now: number, background = false): Work | undefined {
    let best: Work | undefined;
    for (const value of this.entries.values())
      if (
        value.due <= now &&
        (!best ||
          (!background && value.urgent && !best.urgent) ||
          ((background || value.urgent === best.urgent) &&
            value.due < best.due))
      )
        best = value;
    if (best) this.entries.delete(`${best.cx},${best.cz}`);
    return best;
  }
  get size() {
    return this.entries.size;
  }
  get oldest() {
    return Math.min(
      Date.now(),
      ...Array.from(this.entries.values(), (v) => v.marked),
    );
  }
}

export class Outbox {
  private pending = new Map<
    string,
    { sample: Sample; key: string; bytes: number }
  >();
  private acknowledged = new Map<string, string>();
  private acknowledgedBytes = 0;
  bytes = 0;
  overflow = 0;
  offer(sample: Sample, force = false) {
    const coord = `${sample.chunk.cx},${sample.chunk.cz}`;
    const key = JSON.stringify([sample.materials, sample.chunk]);
    const old = this.pending.get(coord);
    if (!force && this.acknowledged.get(coord) === key && !old) return;
    if (old) {
      this.bytes -= old.bytes;
      this.pending.delete(coord);
    }
    if (this.bytes + key.length * 2 > 8 * 1024 * 1024) {
      this.overflow++;
      return;
    }
    this.pending.set(coord, { sample, key, bytes: key.length * 2 });
    this.bytes += key.length * 2;
  }
  next() {
    return this.pending.entries().next().value as
      [string, { sample: Sample; key: string; bytes: number }] | undefined;
  }
  acknowledge(coord: string, key: string) {
    const entry = this.pending.get(coord);
    if (entry?.key === key) {
      this.bytes -= entry.bytes;
      this.pending.delete(coord);
    }
    this.acknowledgedBytes -= (this.acknowledged.get(coord)?.length ?? 0) * 2;
    this.acknowledged.delete(coord);
    this.acknowledged.set(coord, key);
    this.acknowledgedBytes += key.length * 2;
    // The suppression cache is expendable; eviction only causes another full observation.
    while (
      this.acknowledged.size > 512 ||
      this.acknowledgedBytes > 8 * 1024 * 1024
    ) {
      const oldest = this.acknowledged.keys().next().value!;
      this.acknowledgedBytes -= this.acknowledged.get(oldest)!.length * 2;
      this.acknowledged.delete(oldest);
    }
  }
  resetAcknowledged() {
    this.acknowledged.clear();
    this.acknowledgedBytes = 0;
  }
  get oldest() {
    return Math.min(
      Date.now(),
      ...Array.from(this.pending.values(), (v) => v.sample.start),
    );
  }
}
