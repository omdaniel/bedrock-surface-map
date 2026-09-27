import type { DecodeObject } from "./decoder-data.ts";
import { MAX_TILE_BYTES } from "./protocol.ts";

/** One pool for every job; cancellation acknowledges only after its readers drain. */
export class DecoderDownloads {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly fetchObject: typeof fetch;

  constructor(fetchObject: typeof fetch = fetch) {
    this.fetchObject = fetchObject.bind(globalThis);
  }

  async readAll(jobs: readonly DecodeObject[], controller: AbortController) {
    const output = new Array<Uint8Array>(jobs.length);
    let next = 0;
    let failure: unknown;
    let failed = false;
    const pump = async () => {
      try {
        while (next < jobs.length) {
          controller.signal.throwIfAborted();
          const index = next++;
          output[index] = await this.read(jobs[index], controller.signal);
        }
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
        controller.abort();
      }
    };
    // Await both pumps, including the sibling aborted by a failed fetch.
    await Promise.all([pump(), pump()]);
    if (failed) throw failure;
    controller.signal.throwIfAborted();
    return output;
  }

  private async read(job: DecodeObject, signal: AbortSignal) {
    if (this.active === 2)
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    try {
      signal.throwIfAborted();
      return await this.bytes(job, signal);
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }

  private async bytes(job: DecodeObject, signal: AbortSignal) {
    if (
      !Number.isSafeInteger(job.ref.bytes) ||
      job.ref.bytes < 1 ||
      job.ref.bytes > MAX_TILE_BYTES
    )
      throw Error("LOD payload size limit");
    const response = await this.fetchObject(job.url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
      redirect: "error",
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw Error(`LOD data HTTP ${response.status}`);
    }
    const declared = response.headers.get("content-length");
    if (declared !== null && Number(declared) !== job.ref.bytes) {
      await response.body.cancel().catch(() => {});
      throw Error("LOD response length mismatch");
    }
    const output = new Uint8Array(job.ref.bytes);
    const reader = response.body.getReader();
    let offset = 0;
    try {
      for (;;) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        if (offset + value.byteLength > output.byteLength)
          throw Error("LOD response exceeds declared size");
        output.set(value, offset);
        offset += value.byteLength;
      }
      if (offset !== output.length) throw Error("Truncated LOD payload");
    } finally {
      await reader.cancel().catch(() => {});
    }
    signal.throwIfAborted();
    const hash = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", output.buffer)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    signal.throwIfAborted();
    if (hash !== job.ref.sha256) throw Error("LOD payload checksum mismatch");
    return output;
  }
}
