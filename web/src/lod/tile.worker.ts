import init, {
  decode_lod_surface,
  decode_lod_height,
} from "../../pkg/surface_gpu.js";
import {
  configureObjectCache,
  readVerifiedObject,
  type ObjectCacheOptions,
} from "../object-cache";
import type { ObjectRef } from "../types";
import { MAX_TILE_BYTES, TILE_CELLS, type TileKey } from "./protocol.ts";

export interface TileDecodeRequest {
  type: "load";
  id: number;
  key: TileKey;
  url: string;
  object: ObjectRef;
  kind: "surface" | "height";
  materialCount: number;
}
export interface TileDecodeReply {
  id: number;
  key: TileKey;
  kind: "surface" | "height";
  words?: Uint32Array;
  pick?: Int32Array;
  materialMask?: Uint32Array;
  heights?: Float32Array;
  decodeMs: number;
  wasmBytes: number;
  error?: string;
}

const ready = init();
const tasks = new Map<number, AbortController>();
let configured: Promise<unknown> = Promise.resolve();
const scope = self as unknown as {
  onmessage: (
    e: MessageEvent<
      | TileDecodeRequest
      | { type: "cancel"; id: number }
      | { type: "cache"; options: ObjectCacheOptions }
    >,
  ) => void;
  postMessage: (reply: TileDecodeReply, transfer?: Transferable[]) => void;
};
scope.onmessage = async ({ data: request }) => {
  if (request.type === "cancel") {
    tasks.get(request.id)?.abort();
    return;
  }
  if (request.type === "cache") {
    configured = configureObjectCache(request.options);
    return;
  }
  const controller = new AbortController();
  tasks.set(request.id, controller);
  const reply: TileDecodeReply = {
    id: request.id,
    key: request.key,
    kind: request.kind,
    decodeMs: 0,
    wasmBytes: 0,
  };
  try {
    await configured;
    const wasm = await ready;
    if (
      !Number.isInteger(request.materialCount) ||
      request.materialCount < 1 ||
      request.materialCount > 65536
    )
      throw Error("Invalid material count");
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(10000),
    ]);
    const bytes = await readVerifiedObject({
      url: request.url,
      sha256: request.object.sha256,
      bytes: request.object.bytes,
      maxBytes: MAX_TILE_BYTES,
      signal,
    });
    signal.throwIfAborted();
    const start = performance.now(),
      { level, x, z } = request.key;
    const transfer: Transferable[] = [];
    if (request.kind === "height") {
      reply.heights = decode_lod_height(new Uint8Array(bytes), level, x, z);
      if (reply.heights.length !== TILE_CELLS)
        throw Error("Invalid height tile shape");
      transfer.push(reply.heights.buffer as ArrayBuffer);
    } else {
      const words = decode_lod_surface(
        new Uint8Array(bytes),
        level,
        x,
        z,
        request.materialCount,
      );
      const stride = level === 0 ? 8 : 6;
      if (words.length !== TILE_CELLS * stride)
        throw Error("Invalid surface tile shape");
      const pick = new Int32Array(TILE_CELLS * 2),
        heights = new Float32Array(TILE_CELLS);
      const mask =
        level === 0
          ? new Uint32Array(Math.ceil(request.materialCount / 32))
          : undefined;
      for (let i = 0; i < TILE_CELLS; i++) {
        if (level === 0) {
          const present = words[i * 8 + 7] === 1;
          pick[i * 2] = present ? words[i * 8] | 0 : -32768;
          pick[i * 2 + 1] = words[i * 8 + 1];
          heights[i] = present ? pick[i * 2] / 16 : -1e6;
          if (present)
            for (const offset of [1, 3, 5]) {
              const id = words[i * 8 + offset];
              mask![id >>> 5] |= 1 << (id & 31);
            }
        } else {
          const a = words[i * 6 + 3],
            b = words[i * 6 + 4],
            flags = words[i * 6 + 5] >>> 16;
          pick[i * 2] = a;
          pick[i * 2 + 1] = (b & 65535) | (flags << 16);
          heights[i] = flags & 1 ? ((a << 16) >> 16) / 16 : -1e6;
        }
      }
      reply.words = words;
      reply.pick = pick;
      reply.heights = heights;
      reply.materialMask = mask;
      transfer.push(words.buffer as ArrayBuffer, pick.buffer, heights.buffer);
      if (mask) transfer.push(mask.buffer);
    }
    reply.decodeMs = performance.now() - start;
    reply.wasmBytes = wasm.memory.buffer.byteLength;
    signal.throwIfAborted();
    scope.postMessage(reply, transfer);
  } catch (error) {
    if (!controller.signal.aborted)
      scope.postMessage({ ...reply, error: String(error) });
  } finally {
    tasks.delete(request.id);
  }
};
