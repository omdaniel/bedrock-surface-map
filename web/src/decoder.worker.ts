import init, {
  decode_height_samples,
  decode_region_words,
  decode_chunk_words,
  reduce_surface_words,
} from "../pkg/surface_gpu.js";
import type { DecodeRequest, DecodeReply } from "./types";
import { boundedBytes } from "./http";
const ready = init();
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<DecodeRequest>) => void) | null;
  postMessage: (reply: DecodeReply, transfer?: Transferable[]) => void;
};
scope.onmessage = async ({ data: r }) => {
  try {
    await ready;
    const response = await fetch(r.url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${r.url}`);
    const joined = await boundedBytes(response, 64 * 1024 * 1024);
    const buffer = joined.buffer;
    const sha = [
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", buffer)),
    ]
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("");
    if (sha !== r.sha256) throw new Error("Map data checksum mismatch");
    const started = performance.now();
    const bytes = new Uint8Array(buffer);
    let decoded =
      r.kind === "heights"
        ? decode_height_samples(
            bytes,
            r.columns!,
            r.width ?? r.columns!,
            r.stride ?? 1,
          )
        : r.kind === "chunk"
          ? decode_chunk_words(bytes, r.rx!, r.rz!, r.materials!)
          : decode_region_words(bytes, r.rx!, r.rz!, r.materials!);
    if ((r.stride ?? 1) !== 1 && r.kind !== "heights") {
      decoded = reduce_surface_words(
        decoded as Uint32Array,
        r.kind === "chunk" ? 16 : 256,
        r.stride!,
      );
    }
    scope.postMessage(
      { id: r.id, data: decoded, decodeMs: performance.now() - started },
      [decoded.buffer as ArrayBuffer],
    );
  } catch (e) {
    scope.postMessage({ id: r.id, error: String(e) });
  }
};
