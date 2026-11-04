import type { ObjectRef } from "./types";

/** Limits compressed bytes, independently of the dataset's disk quota. */
export const MAX_OBJECT_BYTES = 32 * 1024 * 1024;
export interface LocalObjectRequest extends ObjectRef {
  signal?: AbortSignal;
}

export class ObjectIntegrityError extends Error {
  override name = "ObjectIntegrityError";
}

/** Exported compressed terrain and hash-pinned catalog/atlas files, never worlds. */
export function validateObjectRef(ref: ObjectRef): void {
  if (
    !ref ||
    !/^[a-f0-9]{64}$/.test(ref.sha256) ||
    !Number.isSafeInteger(ref.bytes) ||
    ref.bytes <= 0 ||
    ref.bytes > MAX_OBJECT_BYTES
  )
    throw new TypeError("Invalid local object SHA-256 or compressed size");
  if (
    typeof ref.url !== "string" ||
    /[\\%?#\s\u0000-\u001f\u007f]/.test(ref.url)
  )
    throw new TypeError("Invalid local object URL");
  const url = new URL(ref.url);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.origin !== location.origin ||
    url.href !== ref.url ||
    url.username ||
    url.password ||
    /\/(?:players|tracking|worlds?\/db)(?:\/|$)/i.test(url.pathname) ||
    !new RegExp(
      `/(?:objects/${ref.sha256}\\.(?:zst|json|png)|regions/${ref.sha256}\\.bsm\\.zst|heights/${ref.sha256}\\.i16\\.zst|assets/${ref.sha256}\\.png)$`,
    ).test(url.pathname)
  )
    throw new TypeError(
      "Expected an absolute same-origin compressed map object URL",
    );
}

export async function verifyObjectBytes(
  buffer: ArrayBuffer,
  ref: LocalObjectRequest,
): Promise<void> {
  ref.signal?.throwIfAborted();
  if (buffer.byteLength !== ref.bytes)
    throw new ObjectIntegrityError("Local object compressed size mismatch");
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  ref.signal?.throwIfAborted();
  const actual = Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  if (actual !== ref.sha256)
    throw new ObjectIntegrityError("Local object SHA-256 mismatch");
}
