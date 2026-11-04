import type { LodNode } from "./protocol.ts";
import type { TileDecodeReply, TileDecodeRequest } from "./tile.worker";

export class TileDecoder {
  private readonly worker: Worker;
  private sequence = 0;
  private entries = new Map<
    number,
    {
      resolve: (r: TileDecodeReply) => void;
      reject: (error: unknown) => void;
      cleanup: () => void;
    }
  >();
  private disposed = false;
  decodeMs = 0;
  wasmBytes = 0;
  constructor() {
    this.worker = new Worker(new URL("./tile.worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.onmessage = ({ data: r }: MessageEvent<TileDecodeReply>) => {
      this.wasmBytes = Math.max(this.wasmBytes, r.wasmBytes);
      this.decodeMs += r.decodeMs;
      const entry = this.entries.get(r.id);
      if (!entry) return;
      this.entries.delete(r.id);
      entry.cleanup();
      if (r.error) entry.reject(Error(r.error));
      else entry.resolve(r);
    };
    this.worker.onerror = (event) =>
      this.fail(Error(event.message || "Terrain decoder failed"));
    this.worker.onmessageerror = () =>
      this.fail(Error("Terrain decoder reply invalid"));
  }
  load(
    node: LodNode,
    kind: TileDecodeRequest["kind"],
    materialCount: number,
    signal: AbortSignal,
    bytes: ArrayBuffer,
  ): Promise<TileDecodeReply> {
    signal.throwIfAborted();
    if (this.disposed)
      return Promise.reject(Error("Terrain decoder is closed"));
    if (this.entries.size >= 2)
      return Promise.reject(Error("Terrain decode concurrency exceeded"));
    const id = ++this.sequence,
      object = kind === "surface" ? node.data : node.height;
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.worker.postMessage({ type: "cancel", id });
        this.entries.delete(id);
        signal.removeEventListener("abort", abort);
        reject(signal.reason);
      };
      this.entries.set(id, {
        resolve,
        reject,
        cleanup: () => signal.removeEventListener("abort", abort),
      });
      signal.addEventListener("abort", abort, { once: true });
      this.worker.postMessage(
        {
          type: "load",
          id,
          key: node.key,
          object,
          kind,
          materialCount,
          bytes,
        } satisfies TileDecodeRequest,
        [bytes],
      );
    });
  }
  private fail(error: Error) {
    this.disposed = true;
    for (const entry of this.entries.values()) {
      entry.cleanup();
      entry.reject(error);
    }
    this.entries.clear();
    this.worker.terminate();
  }
  dispose() {
    this.fail(new DOMException("Terrain decoder disposed", "AbortError"));
  }
}
