import { assertLiveRevision } from "./live.ts";
import {
  localAsset,
  MAX_INDEX_BYTES,
  parseManifest,
  type LodManifest,
} from "./protocol.ts";

export const HEALTH_POLL_BYTES = 16 * 1024;
export const ROOT_POLL_BYTES =
  (MAX_INDEX_BYTES + HEALTH_POLL_BYTES) * 10 + 8192;

export type LodFeedState =
  | "starting"
  | "live"
  | "updating"
  | "stale"
  | "degraded"
  | "disabled"
  | "delayed";
export interface LodPublication {
  status: "starting" | "live" | "updating" | "degraded" | "disabled";
  revision_lag: number;
  pending_age_ms: number | null;
  last_published_ms: number | null;
  reason: string | null;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid LOD publication health object");
  return value as Record<string, unknown>;
}
function counter(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw Error("Invalid LOD publication health counter");
  return Number(value);
}
function reason(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string")
    throw Error("Invalid LOD publication health reason");
  if (!value || value === "live") return null;
  return /^[a-z][a-z0-9-]{0,79}$/.test(value) ? value : "unavailable";
}

/** Keep only bounded diagnostics, never the server's full health document. */
export function parsePublicationHealth(
  value: unknown,
  current: LodManifest,
): { state: LodFeedState; publication: LodPublication } {
  const health = record(value);
  if (
    health.schema_version !== 1 ||
    !current.world_id ||
    health.world_id !== current.world_id ||
    health.generation !== current.generation
  )
    throw Error("Invalid LOD publication health identity");
  if (
    typeof health.status !== "string" ||
    !["starting", "live", "stale", "degraded", "disabled"].includes(
      health.status,
    )
  )
    throw Error("Invalid LOD gameplay health status");
  const lod = record(health.lod);
  if (
    typeof lod.status !== "string" ||
    !["starting", "live", "updating", "degraded", "disabled"].includes(
      lod.status,
    )
  )
    throw Error("Invalid LOD publication health status");
  const gameplayReason = reason(health.reason);
  const publication: LodPublication = {
    status: lod.status as LodPublication["status"],
    revision_lag: counter(lod.revision_lag),
    pending_age_ms:
      lod.pending_age_ms === null ? null : counter(lod.pending_age_ms),
    last_published_ms:
      lod.last_published_ms === null ? null : counter(lod.last_published_ms),
    reason: reason(lod.reason) ?? gameplayReason,
  };
  const states = [health.status, publication.status];
  const state: LodFeedState = states.includes("disabled")
    ? "disabled"
    : states.includes("degraded")
      ? "degraded"
      : states.includes("stale")
        ? "stale"
        : states.includes("starting")
          ? "starting"
          : states.includes("updating") || publication.revision_lag > 0
            ? "updating"
            : "live";
  return { state, publication };
}

/** One bounded read at a time; a successful unchanged poll has no draw callback. */
export interface LodSnapshotSource {
  readonly capacityBytes: number;
  read(signal: AbortSignal): Promise<LodManifest | null>;
}

export class LodRootSource {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private abort: AbortController | null = null;
  private stopped = false;
  private visible = true;
  private etag: string | null = null;
  private errors = 0;
  private rerun = false;
  private current: LodManifest;
  private readonly url: URL;
  private readonly healthURL: URL | undefined;
  private readonly source: LodSnapshotSource | undefined;
  private readonly accept: (root: LodManifest) => Promise<void>;
  private readonly reserve: () => boolean;
  private readonly release: () => void;
  private readonly status: (state: LodFeedState) => void;
  state: LodFeedState;
  publication: LodPublication | null = null;
  error: string | null = null;

  constructor(
    url: URL,
    current: LodManifest,
    accept: (root: LodManifest) => Promise<void>,
    reserve: () => boolean,
    release: () => void,
    status: (state: LodFeedState) => void,
    healthURL?: URL,
    source?: LodSnapshotSource,
  ) {
    this.url = new URL(url);
    this.source = source;
    if (healthURL) {
      if (!current.world_id || healthURL.href.length > 2048)
        throw Error("Invalid LOD publication health URL");
      this.healthURL = new URL(localAsset(healthURL.href, this.url));
    }
    this.state = healthURL ? "starting" : "live";
    this.current = current;
    this.accept = accept;
    this.reserve = reserve;
    this.release = release;
    this.status = status;
  }

  visibility(visible: boolean) {
    this.visible = visible;
    clearTimeout(this.timer);
    if (!visible) this.abort?.abort();
    else this.refresh();
  }
  refresh() {
    if (this.stopped || !this.visible) return;
    clearTimeout(this.timer);
    if (this.abort) this.rerun = true;
    else void this.poll();
  }
  private async poll() {
    if (this.stopped || !this.visible || this.abort) return;
    const abort = new AbortController();
    this.abort = abort;
    let reserved = false;
    try {
      reserved = this.reserve();
      if (!reserved) throw Error("LOD root update awaits memory headroom");
      if (this.source) {
        const value = await this.source.read(abort.signal);
        if (value) {
          const next = parseManifest(value, new URL(".", this.url));
          await this.adopt(next, abort.signal);
        }
      } else {
        const response = await fetch(this.url, {
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]),
          headers: this.etag ? { "If-None-Match": this.etag } : {},
          redirect: "error",
          cache: "no-cache",
        });
        if (response.status !== 304) {
          const bytes = await readBytes(response, MAX_INDEX_BYTES);
          const next = parseManifest(
            JSON.parse(new TextDecoder().decode(bytes)),
            new URL(".", this.url),
          );
          await this.adopt(next, abort.signal);
          this.etag = response.headers.get("etag");
        }
      }
      abort.signal.throwIfAborted();
      let nextHealth: ReturnType<typeof parsePublicationHealth> | undefined;
      if (this.healthURL) {
        const healthResponse = await fetch(this.healthURL, {
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]),
          redirect: "error",
          cache: "no-cache",
        });
        const bytes = await readBytes(healthResponse, HEALTH_POLL_BYTES);
        let health: unknown;
        try {
          health = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          throw Error("Invalid LOD publication health JSON");
        }
        nextHealth = parsePublicationHealth(health, this.current);
      }
      abort.signal.throwIfAborted();
      this.errors = 0;
      this.error = null;
      this.state = nextHealth?.state ?? "live";
      if (nextHealth) this.publication = nextHealth.publication;
      this.status(this.state);
    } catch (error) {
      if (!abort.signal.aborted) {
        this.errors++;
        this.error = String(error);
        this.state = "delayed";
        this.status(this.state);
      }
    } finally {
      if (reserved) this.release();
      this.abort = null;
      if (!this.stopped && this.visible) {
        const delay = this.rerun
          ? 0
          : Math.min(30000, 2000 * 2 ** Math.min(this.errors, 4));
        this.rerun = false;
        this.timer = setTimeout(() => void this.poll(), delay);
      }
    }
  }
  private async adopt(next: LodManifest, signal: AbortSignal) {
    assertLiveRevision(this.current, next);
    if (
      next.revision === this.current.revision &&
      JSON.stringify(next) !== JSON.stringify(this.current)
    )
      throw Error("LOD content changed without a new revision");
    signal.throwIfAborted();
    if (next.revision !== this.current.revision) {
      await this.accept(next);
      this.current = next;
    }
  }
  destroy() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.abort?.abort();
  }
}

export async function readBytes(
  response: Response,
  maximum: number,
  exact?: number,
): Promise<Uint8Array> {
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw Error(`LOD HTTP ${response.status}`);
  }
  const length = Number(response.headers.get("content-length"));
  if (length > maximum || (exact !== undefined && length && length !== exact)) {
    await response.body.cancel().catch(() => {});
    throw Error("LOD response length limit");
  }
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
