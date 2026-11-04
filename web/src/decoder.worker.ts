import init, {
  decode_height_samples,
  decode_region_words,
  decode_chunk_words,
  reduce_surface_words,
  decode_region_heights,
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
    const buffer = r.bytes;
    if (!buffer || buffer.byteLength > 32 * 1024 * 1024)
      throw Error("Decoder requires a bounded local object");
    const sha = [
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", buffer)),
    ]
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("");
    if (sha !== r.sha256) throw new Error("Map data checksum mismatch");
    const started = performance.now();
    const bytes = new Uint8Array(buffer);
    let decoded =
      r.kind === "region-heights"
        ? decode_region_heights(
            bytes,
            r.rx!,
            r.rz!,
            r.materials!,
            r.stride ?? 1,
          )
        : r.kind === "heights"
          ? decode_height_samples(
              bytes,
              r.columns!,
              r.width ?? r.columns!,
              r.stride ?? 1,
            )
          : r.kind === "chunk"
            ? decode_chunk_words(bytes, r.rx!, r.rz!, r.materials!)
            : decode_region_words(bytes, r.rx!, r.rz!, r.materials!);
    if (
      (r.stride ?? 1) !== 1 &&
      r.kind !== "heights" &&
      r.kind !== "region-heights"
    ) {
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
