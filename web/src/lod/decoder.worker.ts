import init, { decode_lod_words } from "../../pkg/surface_gpu.js";
import type { TileKey } from "./protocol";
import type { ObjectRef } from "../types";

export interface DecodeJob {
  type: "load";
  id: number;
  url: string;
  ref: ObjectRef;
  key: TileKey;
  kind: "detail" | "summary" | "height";
  materials: number;
}
export interface DecodeResult {
  id: number;
  words?: Uint32Array;
  pick?: Int32Array;
  materialMask?: Uint32Array;
  wasmBytes: number;
  decodeMs: number;
  error?: string;
}
const ready = init();
const controllers = new Map<number, AbortController>();
let queue = Promise.resolve();
const scope = self as unknown as {
  onmessage: (
    event: MessageEvent<DecodeJob | { type: "cancel"; id: number }>,
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
  // Fetches may overlap, but native decoding has exactly one owner.
  const fetched = bytes(data, controller.signal);
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
      const { key } = data;
      const started = performance.now();
      const words = decode_lod_words(
        input,
        data.kind,
        key.level,
        key.x,
        key.z,
        data.materials,
      );
      decodeMs = performance.now() - started;
      wasmBytes = module.memory.buffer.byteLength;
      if (wasmBytes > 16 * 1024 * 1024)
        throw Error("LOD decoder exceeds its WASM memory allowance");
      controller.signal.throwIfAborted();
      let pick: Int32Array | undefined;
      const materialMask =
        data.kind === "detail"
          ? new Uint32Array(Math.ceil(data.materials / 32))
          : undefined;
      if (data.kind !== "height") {
        pick = new Int32Array(128 * 128 * 2);
        for (let i = 0; i < 128 * 128; i++) {
          if (data.kind === "detail") {
            pick[i * 2] = words[i * 8 + 7] === 1 ? words[i * 8] : -32768;
            pick[i * 2 + 1] = words[i * 8 + 1];
            for (const offset of [1, 3, 5]) {
              const id = words[i * 8 + offset];
              materialMask![id >>> 5] |= 1 << (id & 31);
            }
          } else {
            pick[i * 2] = words[i * 6 + 3];
            pick[i * 2 + 1] =
              (words[i * 6 + 4] & 0xffff) | (words[i * 6 + 5] & 0xffff0000);
          }
        }
      }
      scope.postMessage(
        {
          id: data.id,
          words,
          pick,
          materialMask,
          wasmBytes,
          decodeMs,
        },
        [
          words.buffer as ArrayBuffer,
          ...(pick ? [pick.buffer as ArrayBuffer] : []),
          ...(materialMask ? [materialMask.buffer as ArrayBuffer] : []),
        ],
      );
    } catch (error) {
      controller.abort();
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

async function bytes(job: DecodeJob, signal: AbortSignal) {
  if (job.ref.bytes < 1 || job.ref.bytes > 2 * 1024 * 1024)
    throw Error("LOD payload size limit");
  const response = await fetch(job.url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
    redirect: "error",
  });
  if (!response.ok || !response.body)
    throw Error(`LOD data HTTP ${response.status}`);
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) !== job.ref.bytes)
    throw Error("LOD response length mismatch");
  const output = new Uint8Array(job.ref.bytes);
  const reader = response.body.getReader();
  let offset = 0;
  try {
    for (;;) {
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
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", output.buffer)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  if (hash !== job.ref.sha256) throw Error("LOD payload checksum mismatch");
  return output;
}
