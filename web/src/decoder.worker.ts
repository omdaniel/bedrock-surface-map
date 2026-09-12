import init, {
  decode_heights,
  decode_region_words,
  decode_chunk_words,
} from "../pkg/surface_gpu.js";
import type { DecodeRequest, DecodeReply } from "./types";
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
    if (!response.body) throw new Error("Empty map response");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 64 * 1024 * 1024) {
        await reader.cancel();
        throw new Error("Compressed payload too large");
      }
      chunks.push(value);
    }
    const joined = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const buffer = joined.buffer;
    const sha = [
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", buffer)),
    ]
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("");
    if (sha !== r.sha256) throw new Error("Map data checksum mismatch");
    const started = performance.now();
    const bytes = new Uint8Array(buffer);
    const decoded =
      r.kind === "heights"
        ? decode_heights(bytes, r.columns!)
        : r.kind === "chunk"
          ? decode_chunk_words(bytes, r.rx!, r.rz!, r.materials!)
          : decode_region_words(bytes, r.rx!, r.rz!, r.materials!);
    scope.postMessage(
      { id: r.id, data: decoded, decodeMs: performance.now() - started },
      [decoded.buffer as ArrayBuffer],
    );
  } catch (e) {
    scope.postMessage({ id: r.id, error: String(e) });
  }
};
