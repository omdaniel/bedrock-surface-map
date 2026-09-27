import type { ObjectRef } from "../types";
import {
  localAsset,
  parseRef,
  type LodNode,
  type TileKey,
} from "./protocol.ts";
import { prepareUpdate, type ChunkRef } from "./decoder-data.ts";
import type {
  DecodeJob,
  DecodeResult,
  DecodeUpdateJob,
} from "./decoder.worker";

export type { ChunkRef } from "./decoder-data.ts";
export type { DecodeResult } from "./decoder.worker";

export class LodDecoder {
  private worker: Worker | null = null;
  private sequence = 0;
  private disposed = false;
  private workerFailure: Error | null = null;
  private readonly pending = new Map<
    number,
    {
      resolve: (result: DecodeResult) => void;
      reject: (error: Error) => void;
      cleanup: () => void;
      signal: AbortSignal;
    }
  >();
  wasmBytes = 0;
  decodeMs = 0;
  constructor() {
    this.startWorker();
  }
  private startWorker() {
    this.workerFailure = null;
    const worker = new Worker(new URL("./decoder.worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker = worker;
    worker.onmessage = ({ data }: MessageEvent<DecodeResult>) => {
      if (this.worker !== worker || this.disposed) return;
      this.wasmBytes = Math.max(this.wasmBytes, data.wasmBytes);
      this.decodeMs += data.decodeMs;
      if (data.restartRequired) {
        this.failWorker(worker, Error(data.error ?? "LOD decoder init failed"));
        return;
      }
      const entry = this.pending.get(data.id);
      if (!entry) return;
      this.pending.delete(data.id);
      entry.cleanup();
      if (entry.signal.aborted) entry.reject(entry.signal.reason);
      else if (data.error) entry.reject(Error(data.error));
      else entry.resolve(data);
    };
    worker.onerror = (event) => {
      event.preventDefault?.();
      this.failWorker(
        worker,
        Error(event.message || "LOD decoder worker failed"),
      );
    };
  }
  private failWorker(worker: Worker, error: Error) {
    if (this.worker !== worker) return;
    this.workerFailure = error;
    this.worker = null;
    worker.terminate();
    for (const entry of this.pending.values()) {
      entry.cleanup();
      entry.reject(entry.signal.aborted ? entry.signal.reason : error);
    }
    this.pending.clear();
  }
  retry() {
    // One replacement per explicit retry; a failed worker never respawns on load.
    if (this.disposed || this.worker) return;
    this.startWorker();
  }
  load(
    ref: ObjectRef,
    key: TileKey,
    kind: DecodeJob["kind"],
    base: URL,
    materials: number,
    signal: AbortSignal,
    absenceSource?: TileKey,
  ) {
    signal.throwIfAborted();
    const checked = parseRef(ref, base);
    return this.dispatch(
      {
        type: "load",
        url: localAsset(checked.url, base),
        ref: checked,
        key,
        kind,
        materials,
        absenceSource,
      },
      signal,
    );
  }
  update(
    node: LodNode,
    chunks: ChunkRef[] | null,
    base: URL,
    materials: number,
    signal: AbortSignal,
  ): Promise<DecodeResult> {
    signal.throwIfAborted();
    return this.dispatch(
      {
        type: "update",
        ...prepareUpdate(node, chunks, base, materials),
      },
      signal,
    );
  }
  private dispatch(
    job: Omit<DecodeJob, "id"> | Omit<DecodeUpdateJob, "id">,
    signal: AbortSignal,
  ) {
    if (this.disposed) throw Error("LOD decoder disposed");
    const worker = this.worker;
    if (!worker)
      throw Error(
        `LOD decoder failed; Retry to restart${this.workerFailure ? ` (${this.workerFailure.message})` : ""}`,
        { cause: this.workerFailure },
      );
    if (this.pending.size >= 2) throw Error("LOD decode concurrency limit");
    return new Promise<DecodeResult>((resolve, reject) => {
      const id = ++this.sequence;
      const cancel = () => {
        try {
          worker.postMessage({ type: "cancel", id });
        } catch (error) {
          this.failWorker(worker, Error(String(error)));
        }
        // Retain the slot until the worker acknowledges: cancellation is not deallocation.
      };
      signal.addEventListener("abort", cancel, { once: true });
      this.pending.set(id, {
        resolve,
        reject,
        signal,
        cleanup: () => signal.removeEventListener("abort", cancel),
      });
      try {
        worker.postMessage({ ...job, id });
      } catch (error) {
        this.pending.delete(id);
        signal.removeEventListener("abort", cancel);
        reject(error);
      }
    });
  }
  destroy() {
    this.disposed = true;
    if (this.worker)
      this.failWorker(this.worker, Error("LOD decoder disposed"));
  }
}
