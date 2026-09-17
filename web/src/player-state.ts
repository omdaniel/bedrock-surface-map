export interface PlayerPosition {
  x: number;
  y: number;
  z: number;
  heading: number;
}
export interface LivePlayer {
  id: string;
  name: string;
  dimension: string | null;
  position: PlayerPosition | null;
  discontinuity: boolean;
}
export interface PlayerSnapshot {
  schema_version: 1;
  world_id: string;
  instance_id: string;
  started_at_ms: number;
  sequence: number;
  sampled_at_ms: number;
  pack_version: string;
  players: LivePlayer[];
}
export interface PlayerView {
  schema_version: 1;
  world_id: string;
  status: "starting" | "live" | "stale" | "unavailable" | "disabled";
  reason: string | null;
  age_ms: number | null;
  snapshot: PlayerSnapshot | null;
}
export interface PlayerBinding {
  world_id: string;
  source_sha256: string;
  url: string;
  generation?: string;
  poll_interval_ms?: number;
}
export interface Camera {
  cx: number;
  cz: number;
  scale: number;
  width: number;
  height: number;
}
export function project(p: PlayerPosition, camera: Camera) {
  return {
    x: camera.width / 2 + (p.x - camera.cx) * camera.scale,
    y: camera.height / 2 + (p.z - camera.cz) * camera.scale,
  };
}
const id = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(v);
const uint = (v: unknown): v is number =>
  Number.isSafeInteger(v) && Number(v) >= 0;
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
export function binding(
  value: unknown,
  fingerprint: string,
  live?: { world_id: string; generation: string },
): PlayerBinding | null {
  if (!object(value) || value.players === null) return null;
  const p = value.players;
  if (
    !object(p) ||
    !id(p.world_id) ||
    (live
      ? p.world_id !== live.world_id || p.generation !== live.generation
      : p.source_sha256 !== fingerprint) ||
    p.url !== `/api/v1/worlds/${p.world_id}/players` ||
    (p.poll_interval_ms !== undefined &&
      (!Number.isInteger(p.poll_interval_ms) ||
        Number(p.poll_interval_ms) < 100 ||
        Number(p.poll_interval_ms) > 2000))
  )
    return null;
  return p as unknown as PlayerBinding;
}
export function playerPollDelay(
  interval: number,
  failures: number,
  empty: boolean,
  elapsed: number,
) {
  if (failures) return Math.min(30000, 2000 * 2 ** Math.min(failures - 1, 4));
  return Math.max(0, (empty ? 2000 : interval) - elapsed);
}
export function parseView(value: unknown, world: string): PlayerView {
  if (
    !object(value) ||
    value.schema_version !== 1 ||
    value.world_id !== world ||
    !["starting", "live", "stale", "unavailable", "disabled"].includes(
      String(value.status),
    ) ||
    !(value.age_ms === null || uint(value.age_ms))
  )
    throw Error("Invalid player response");
  const s = value.snapshot;
  if (s !== null) {
    if (
      !object(s) ||
      s.schema_version !== 1 ||
      s.world_id !== world ||
      !id(s.instance_id) ||
      !uint(s.sequence) ||
      s.sequence === 0 ||
      !uint(s.started_at_ms) ||
      !uint(s.sampled_at_ms) ||
      s.started_at_ms > s.sampled_at_ms ||
      !Array.isArray(s.players) ||
      s.players.length > 32 ||
      !uint(value.age_ms) ||
      !["live", "stale"].includes(String(value.status))
    )
      throw Error("Invalid player snapshot");
    const ids = new Set<string>();
    for (const p of s.players) {
      if (
        !object(p) ||
        !id(p.id) ||
        ids.has(p.id) ||
        typeof p.name !== "string" ||
        !p.name.length ||
        p.name.length > 128 ||
        /[\u0000-\u001f\u007f]/.test(p.name) ||
        typeof p.discontinuity !== "boolean" ||
        ![
          null,
          "minecraft:overworld",
          "minecraft:nether",
          "minecraft:the_end",
        ].includes(p.dimension as string | null)
      )
        throw Error("Invalid player");
      ids.add(p.id);
      const v = p.position;
      if (
        v !== null &&
        (!object(v) ||
          p.dimension === null ||
          ![v.x, v.y, v.z, v.heading].every(
            (n) => typeof n === "number" && Number.isFinite(n),
          ) ||
          Math.abs(Number(v.x)) > 30000000 ||
          Math.abs(Number(v.z)) > 30000000 ||
          Math.abs(Number(v.y)) > 1000000 ||
          Number(v.heading) < 0 ||
          Number(v.heading) >= 360)
      )
        throw Error("Invalid player position");
    }
  } else if (["live", "stale"].includes(String(value.status)))
    throw Error("Missing live snapshot");
  return value as unknown as PlayerView;
}
export class PlayerState {
  view: PlayerView | null = null;
  received = 0;
  private highWater: PlayerSnapshot | null = null;
  accept(view: PlayerView, now: number) {
    const next = view.snapshot,
      old = this.highWater;
    if (
      next &&
      old &&
      (next.started_at_ms < old.started_at_ms ||
        (next.started_at_ms === old.started_at_ms &&
          next.instance_id !== old.instance_id) ||
        (next.instance_id === old.instance_id &&
          next.sequence < old.sequence) ||
        next.sampled_at_ms < old.sampled_at_ms)
    )
      throw Error("Obsolete player response");
    if (
      next &&
      old &&
      next.instance_id === old.instance_id &&
      next.sequence === old.sequence
    ) {
      view.age_ms = Math.max(view.age_ms ?? 0, this.age(now) ?? 0);
    }
    if (next) this.highWater = { ...next, players: [] };
    this.view = view;
    this.received = now;
  }
  age(now: number) {
    return this.view?.age_ms == null
      ? null
      : this.view.age_ms + Math.max(0, now - this.received);
  }
  status(now: number) {
    const age = this.age(now);
    if (age !== null && age >= 30000 && this.view?.snapshot)
      this.view.snapshot = null;
    if (!this.view) return "starting";
    if (["starting", "disabled", "unavailable"].includes(this.view.status))
      return this.view.status;
    return age !== null && age >= 30000
      ? "unavailable"
      : age !== null && age >= 10000
        ? "stale"
        : this.view.status;
  }
}
export async function readJsonBounded(response: Response) {
  if (!response.body) throw Error("Empty player response");
  const reader = response.body.getReader();
  let total = 0;
  const parts: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 32768) throw Error("Player response too large");
      parts.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    all.set(part, offset);
    offset += part.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(all)) as unknown;
}
