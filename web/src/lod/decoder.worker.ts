import init, {
  decode_chunk_words,
  decode_lod_absence,
  decode_lod_words,
} from "../../pkg/surface_gpu.js";
import type { TileKey } from "./protocol";
import type { ObjectRef } from "../types";
import {
  decodeChunkPatch,
  surfacePicking,
  type UpdatePlan,
} from "./decoder-data.ts";
import { DecoderDownloads } from "./decoder-transport.ts";

export interface DecodeJob {
  type: "load";
  id: number;
  url: string;
  ref: ObjectRef;
  key: TileKey;
  kind: "detail" | "summary" | "height";
  materials: number;
  absenceSource?: TileKey;
}
export interface DecodeUpdateJob extends UpdatePlan {
  type: "update";
  id: number;
}
export interface DecodeResult {
  id: number;
  words?: Uint32Array;
  pick?: Int32Array;
  materialMask?: Uint32Array;
  updateKind?: "surface" | "chunks";
  coordinates?: Int32Array;
  heightWords?: Uint32Array;
  wasmBytes: number;
  decodeMs: number;
  error?: string;
}
const ready = init();
const controllers = new Map<number, AbortController>();
const downloads = new DecoderDownloads();
let queue = Promise.resolve();
const scope = self as unknown as {
  onmessage: (
    event: MessageEvent<
      DecodeJob | DecodeUpdateJob | { type: "cancel"; id: number }
    >,
  ) => void;
  postMessage: (reply: DecodeResult, transfer?: Transferable[]) => void;
};
scope.onmessage = ({ data }) => {
  if (data.type === "cancel") {
    controllers.get(data.id)?.abort();
    return;
  }
  const controller = new AbortController();
  controllers.set(data.id, controller);
  const objects =
    data.type === "load"
      ? [data]
      : [
          ...(data.updateKind === "surface" ? [data.surface!] : data.chunks!),
          data.height,
        ];
  // Downloads share a global two-object limit; native decoding has one owner.
  const fetched = downloads.readAll(objects, controller);
  void fetched.catch(() => {});
  queue = queue.then(async () => {
    let wasmBytes = 0;
    let decodeMs = 0;
    let memory: WebAssembly.Memory | undefined;
    try {
      const module = await ready;
      memory = module.memory;
      wasmBytes = module.memory.buffer.byteLength;
      const input = await fetched;
      controller.signal.throwIfAborted();
      const native = (decode: () => Uint32Array) => {
        controller.signal.throwIfAborted();
        const started = performance.now();
        let words: Uint32Array;
        try {
          words = decode();
        } finally {
          decodeMs += performance.now() - started;
          wasmBytes = module.memory.buffer.byteLength;
        }
        if (wasmBytes > 16 * 1024 * 1024)
          throw Error("LOD decoder exceeds its WASM memory allowance");
        controller.signal.throwIfAborted();
        return words;
      };
      const { key } = data;
      const lod = (bytes: Uint8Array, kind: DecodeJob["kind"]) =>
        native(() =>
          decode_lod_words(
            bytes,
            kind,
            key.level,
            key.x,
            key.z,
            data.materials,
          ),
        );
      const result: DecodeResult = { id: data.id, wasmBytes, decodeMs };
      if (data.type === "load") {
        if (data.absenceSource && data.kind !== "summary")
          throw Error("Only coarse edge sources support absence projection");
        const source = data.absenceSource;
        result.words = source
          ? native(() =>
              decode_lod_absence(
                input[0],
                source.level,
                source.x,
                source.z,
                key.level,
                key.x,
                key.z,
              ),
            )
          : lod(input[0], data.kind);
        if (data.kind !== "height")
          Object.assign(
            result,
            surfacePicking(result.words, data.kind, data.materials),
          );
      } else {
        result.updateKind = data.updateKind;
        if (data.updateKind === "chunks") {
          const chunks = data.chunks!;
          Object.assign(
            result,
            decodeChunkPatch(chunks, data.materials, (i) =>
              native(() =>
                decode_chunk_words(
                  input[i],
                  chunks[i].cx,
                  chunks[i].cz,
                  data.materials,
                ),
              ),
            ),
          );
        } else {
          const kind = key.level === 0 ? "detail" : "summary";
          result.words = lod(input[0], kind);
          Object.assign(
            result,
            surfacePicking(result.words, kind, data.materials),
          );
        }
        result.heightWords = lod(input[input.length - 1], "height");
      }
      controller.signal.throwIfAborted();
      result.wasmBytes = wasmBytes;
      result.decodeMs = decodeMs;
      const arrays = [
        result.words,
        result.pick,
        result.materialMask,
        result.coordinates,
        result.heightWords,
      ];
      scope.postMessage(
        result,
        arrays.flatMap((array) => (array ? [array.buffer as ArrayBuffer] : [])),
      );
    } catch (error) {
      controller.abort();
      // Initialization/decode failures must not acknowledge still-owned transfers.
      await fetched.catch(() => {});
      scope.postMessage({
        id: data.id,
        wasmBytes: memory?.buffer.byteLength ?? wasmBytes,
        decodeMs,
        error: String(error),
      });
    } finally {
      controllers.delete(data.id);
    }
  });
};
