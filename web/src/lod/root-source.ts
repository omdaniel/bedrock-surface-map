import { assertLiveRevision } from "./live.ts";
import {
  MAX_INDEX_BYTES,
  parseManifest,
  type LodManifest,
} from "./protocol.ts";

export const ROOT_POLL_BYTES = MAX_INDEX_BYTES * 10 + 8192;

/** One bounded read at a time; a successful unchanged poll has no draw callback. */
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
  private readonly accept: (root: LodManifest) => Promise<void>;
  private readonly reserve: () => boolean;
  private readonly release: () => void;
  private readonly status: (state: "live" | "delayed") => void;
  state: "live" | "delayed" = "live";
  error: string | null = null;

  constructor(
    url: URL,
    current: LodManifest,
    accept: (root: LodManifest) => Promise<void>,
    reserve: () => boolean,
    release: () => void,
    status: (state: "live" | "delayed") => void,
  ) {
    this.url = url;
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
        assertLiveRevision(this.current, next);
        if (
          next.revision === this.current.revision &&
          JSON.stringify(next) !== JSON.stringify(this.current)
        )
          throw Error("LOD content changed without a new revision");
        abort.signal.throwIfAborted();
        if (next.revision !== this.current.revision) {
          await this.accept(next);
          this.current = next;
        }
        this.etag = response.headers.get("etag");
      }
      this.errors = 0;
      this.error = null;
      this.state = "live";
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
