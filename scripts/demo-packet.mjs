import { gzipSync, gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
export const digest = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
const allowed =
  /^(objects\/[a-f0-9]{64}\.(zst|json|png)|stage-[0-3]\.json|scenario\.json|NOTICE\.txt)$/;
export function encodePacket(files) {
  return gzipSync(Buffer.from(JSON.stringify({ version: 1, files })), {
    level: 9,
  });
}
export function decodePacket(bytes, sha) {
  if (bytes.length > 16 * 1024 * 1024 || digest(bytes) !== sha)
    throw Error("Demo packet checksum or size mismatch");
  const packet = JSON.parse(
    gunzipSync(bytes, { maxOutputLength: 32 * 1024 * 1024 }).toString(),
  );
  if (packet.version !== 1 || !packet.files || Array.isArray(packet.files))
    throw Error("Invalid demo packet");
  const entries = Object.entries(packet.files);
  if (entries.length > 10000) throw Error("Demo entry limit");
  let total = 0;
  const files = new Map();
  for (const [name, encoded] of entries) {
    if (
      !allowed.test(name) ||
      typeof encoded !== "string" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        encoded,
      )
    )
      throw Error("Unsafe demo entry");
    const data = Buffer.from(encoded, "base64");
    total += data.length;
    if (total > 24 * 1024 * 1024 || data.length > 2 * 1024 * 1024)
      throw Error("Demo expansion limit");
    if (name.startsWith("objects/") && digest(data) !== name.slice(8, 72))
      throw Error("Demo object checksum");
    files.set(name, data);
  }
  for (const name of [
    "scenario.json",
    "stage-0.json",
    "stage-1.json",
    "stage-2.json",
    "stage-3.json",
    "NOTICE.txt",
  ])
    if (!files.has(name)) throw Error("Incomplete demo packet");
  return files;
}
