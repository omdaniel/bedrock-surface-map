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
  private readonly worker = new Worker(
    new URL("./decoder.worker.ts", import.meta.url),
    { type: "module" },
  );
  private sequence = 0;
  private stopped = false;
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
    this.worker.onmessage = ({ data }: MessageEvent<DecodeResult>) => {
      this.wasmBytes = Math.max(this.wasmBytes, data.wasmBytes);
      this.decodeMs += data.decodeMs;
      const entry = this.pending.get(data.id);
      if (!entry) return;
      this.pending.delete(data.id);
      entry.cleanup();
      if (entry.signal.aborted) entry.reject(entry.signal.reason);
      else if (data.error) entry.reject(Error(data.error));
      else entry.resolve(data);
    };
    this.worker.onerror = (event) => {
      this.stopped = true;
      this.worker.terminate();
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
    if (this.stopped) throw Error("LOD decoder stopped");
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
        signal,
        cleanup: () => signal.removeEventListener("abort", cancel),
      });
      try {
        this.worker.postMessage({ ...job, id });
      } catch (error) {
        this.pending.delete(id);
        signal.removeEventListener("abort", cancel);
        reject(error);
      }
    });
  }
  destroy() {
    this.stopped = true;
    this.worker.terminate();
    for (const entry of this.pending.values()) {
      entry.cleanup();
      entry.reject(Error("LOD decoder stopped"));
    }
    this.pending.clear();
  }
}
