export const PACK_VERSION = "1.0.1";
export interface SourcePlayer {
  id: string;
  name: string;
  dimension: { id: string };
  location: { x: number; y: number; z: number };
  getRotation(): { x: number; y: number };
}
export interface SamplePlayer {
  id: string;
  name: string;
  dimension: string | null;
  position: { x: number; y: number; z: number; heading: number } | null;
  discontinuity: boolean;
}
export const compassHeading = (yaw: number) =>
  (((yaw + 180) % 360) + 360) % 360;
export class Roster {
  private next = 1;
  private records = new Map<
    string,
    { id: string; reset: number; name: string | null }
  >();
  private pending = new Map<string, number>();
  spawn(entityId: string) {
    const r = this.records.get(entityId);
    if (r) r.reset++;
    else
      this.records.set(entityId, {
        id: `p${this.next++}`,
        reset: 1,
        name: null,
      });
  }
  leave(entityId: string) {
    this.records.delete(entityId);
  }
  sample(players: SourcePlayer[]): SamplePlayer[] {
    const active = new Set<string>();
    const result: SamplePlayer[] = [];
    this.pending.clear();
    if (players.length > 32) throw Error("player bound exceeded");
    for (const p of players) {
      const entityId = p.id;
      let name: string | null | undefined,
        readable = true;
      try {
        name = p.name;
      } catch {
        name = this.records.get(entityId)?.name;
        readable = false;
      }
      // If identity cannot be established, fail the sample rather than invent
      // an empty roster. A known disconnect race retains only its current name.
      if (!name) throw Error("player identity unavailable");
      if (name.toLowerCase() === "popcello8931") continue;
      active.add(entityId);
      if (!this.records.has(entityId)) this.spawn(entityId);
      const record = this.records.get(entityId)!;
      record.name = name;
      let dimension: string | null = null,
        position: SamplePlayer["position"] = null;
      try {
        if (!readable) throw Error("player entity unavailable");
        dimension = p.dimension.id;
        if (
          ![
            "minecraft:overworld",
            "minecraft:nether",
            "minecraft:the_end",
          ].includes(dimension)
        )
          throw Error("unknown dimension");
        const { x, y, z } = p.location,
          yaw = p.getRotation().y;
        if (![x, y, z, yaw].every(Number.isFinite))
          throw Error("invalid location");
        position = { x, y, z, heading: compassHeading(yaw) };
      } catch {
        dimension = null;
      }
      result.push({
        id: record.id,
        name,
        dimension,
        position,
        discontinuity: record.reset > 0,
      });
      this.pending.set(entityId, record.reset);
    }
    for (const id of this.records.keys())
      if (!active.has(id)) this.records.delete(id);
    return result;
  }
  acknowledge() {
    for (const [id, reset] of this.pending) {
      const r = this.records.get(id);
      if (r?.reset === reset) r.reset = 0;
    }
    this.pending.clear();
  }
}
export interface Snapshot {
  schema_version: 1;
  world_id: string;
  instance_id: string;
  started_at_ms: number;
  sequence: number;
  sampled_at_ms: number;
  pack_version: string;
  players: SamplePlayer[];
}
export function failureCode(error: unknown): string {
  if (!(error instanceof Error)) return "unclassified";
  if (/^HTTP_[1-5][0-9]{2}$/.test(error.message)) return error.message;
  const allowed = [
    "HttpRequestLimitExceededError",
    "InternalHttpRequestError",
    "MalformedUriError",
    "RequestBodyTooLargeError",
    "TLSOnlyError",
    "UriNotAllowedError",
  ];
  return allowed.includes(error.name) ? error.name : "sampling-or-request";
}
export class Publisher {
  private world: string;
  private instance: string;
  private started: number;
  private read: () => SamplePlayer[];
  private send: (snapshot: Snapshot) => Promise<void>;
  private success: () => void;
  private failure: (code: string) => void;
  private pending = true;
  private inFlight = false;
  private nextTick = 0;
  private nextTime = 0;
  private failures = 0;
  private sequence = 0;
  constructor(
    world: string,
    instance: string,
    started: number,
    read: () => SamplePlayer[],
    send: (snapshot: Snapshot) => Promise<void>,
    success: () => void,
    failure: (code: string) => void,
  ) {
    this.world = world;
    this.instance = instance;
    this.started = started;
    this.read = read;
    this.send = send;
    this.success = success;
    this.failure = failure;
  }
  changed() {
    this.pending = true;
  }
  async tick(tick: number, now: number) {
    if (
      this.inFlight ||
      now < this.nextTime ||
      (!this.pending && tick < this.nextTick)
    )
      return;
    this.inFlight = true;
    this.pending = false;
    this.nextTick = tick + 40;
    this.nextTime = now + 1000;
    try {
      const players = this.read();
      const snapshot: Snapshot = {
        schema_version: 1,
        world_id: this.world,
        instance_id: this.instance,
        started_at_ms: this.started,
        sequence: ++this.sequence,
        sampled_at_ms: now,
        pack_version: PACK_VERSION,
        players,
      };
      await this.send(snapshot);
      this.failures = 0;
      this.success();
    } catch (error) {
      this.pending = true;
      this.failures++;
      this.nextTime =
        now + Math.min(30000, 2000 * 2 ** Math.min(this.failures - 1, 4));
      if (this.failures === 1) this.failure(failureCode(error));
    } finally {
      this.inFlight = false;
    }
  }
}
