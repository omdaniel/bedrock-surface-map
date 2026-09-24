import type { ObjectRef } from "../types";
import { localAsset, type TileKey } from "./protocol";
import type { DecodeJob, DecodeResult } from "./decoder.worker";

export class LodDecoder {
  private readonly worker = new Worker(
    new URL("./decoder.worker.ts", import.meta.url),
    { type: "module" },
  );
  private sequence = 0;
  private readonly pending = new Map<
    number,
    {
      resolve: (result: DecodeResult) => void;
      reject: (error: Error) => void;
      cleanup: () => void;
    }
  >();
  wasmBytes = 0;
  decodeMs = 0;
  constructor() {
    this.worker.onmessage = ({ data }: MessageEvent<DecodeResult>) => {
      this.wasmBytes = Math.max(this.wasmBytes, data.wasmBytes);
      this.decodeMs += data.decodeMs;
      const entry = this.pending.get(data.id);
      if (!entry) return;
      this.pending.delete(data.id);
      entry.cleanup();
      if (data.error) entry.reject(Error(data.error));
      else entry.resolve(data);
    };
    this.worker.onerror = (event) => {
      for (const entry of this.pending.values()) {
        entry.cleanup();
        entry.reject(Error(event.message));
      }
      this.pending.clear();
    };
  }
  load(
    ref: ObjectRef,
    key: TileKey,
    kind: DecodeJob["kind"],
    base: URL,
    materials: number,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    if (this.pending.size >= 2) throw Error("LOD decode concurrency limit");
    return new Promise<DecodeResult>((resolve, reject) => {
      const id = ++this.sequence;
      const cancel = () => {
        this.worker.postMessage({ type: "cancel", id });
        // Retain the slot until the worker acknowledges: cancellation is not deallocation.
      };
      signal.addEventListener("abort", cancel, { once: true });
      this.pending.set(id, {
        resolve,
        reject,
        cleanup: () => signal.removeEventListener("abort", cancel),
      });
      this.worker.postMessage({
        type: "load",
        id,
        url: localAsset(ref.url, base),
        ref,
        key,
        kind,
        materials,
      } satisfies DecodeJob);
    });
  }
  destroy() {
    this.worker.terminate();
    for (const entry of this.pending.values()) {
      entry.cleanup();
      entry.reject(Error("LOD decoder stopped"));
    }
    this.pending.clear();
  }
}
