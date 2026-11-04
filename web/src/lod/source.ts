import { boundedBytes } from "../http";
import { readVerifiedObject } from "../object-cache";
import type { ObjectRef } from "../types";
import {
  localAsset,
  MAX_INDEX_BYTES,
  parseCatalog,
  parseManifest,
  parseNode,
  tileId,
  type LodManifest,
  type LodNode,
  type TileKey,
} from "./protocol.ts";

/** Stateless, static-file-compatible publication reader. Mutable roots are
 * revalidated; only hash-verified immutable objects enter persistent storage.
 */
export class PyramidSource {
  readonly url: URL;
  readonly base: URL;
  root!: LodManifest;
  private etag: string | null = null;
  private signature = "";
  private nodes = new Map<string, { value: LodNode; bytes: number }>();
  private nodeBytes = 0;
  constructor(url: string | URL) {
    this.url = new URL(url, location.href);
    if (
      this.url.origin !== location.origin ||
      this.url.username ||
      this.url.password ||
      this.url.hash
    )
      throw Error("Terrain hierarchy must use this origin");
    this.base = new URL(".", this.url);
  }
  async refresh(
    signal?: AbortSignal,
  ): Promise<"unchanged" | "revision" | "generation" | "appearance"> {
    signal?.throwIfAborted();
    const response = await fetch(this.url, {
      cache: "no-cache",
      signal,
      headers: this.etag ? { "If-None-Match": this.etag } : undefined,
    });
    if (response.status === 304 && this.root) return "unchanged";
    if (!response.ok)
      throw Error(`Terrain hierarchy unavailable (${response.status})`);
    const bytes = await boundedBytes(response, MAX_INDEX_BYTES);
    signal?.throwIfAborted();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const root = parseManifest(JSON.parse(text), this.base);
    const signature = JSON.stringify(root);
    if (signature === this.signature) return "unchanged";
    const sameGeneration =
      this.root?.generation === root.generation &&
      this.root?.world_id === root.world_id;
    if (sameGeneration && root.revision < this.root.revision)
      throw Error("Terrain publication moved backwards");
    if (sameGeneration && root.revision === this.root.revision)
      throw Error("Terrain publication changed without advancing its revision");
    let appearance =
      this.root &&
      (root.appearance_version !== this.root.appearance_version ||
        root.atlas.sha256 !== this.root.atlas.sha256);
    if (sameGeneration && !appearance) {
      if (root.material_count < this.root.material_count) appearance = true;
      for (const [i, old] of this.root.catalog.entries()) {
        const next = root.catalog[i];
        if (!next || next.start !== old.start || next.count < old.count) {
          appearance = true;
          break;
        }
        if (next.sha256 === old.sha256) continue;
        // Append-only additions can change the last page's hash. Compare the
        // existing prefix so descriptor edits cannot silently recolor old fine
        // records underneath cached coarse summaries.
        const read = async (ref: typeof old) =>
          parseCatalog(
            JSON.parse(
              new TextDecoder().decode(
                await this.object(ref, signal, MAX_INDEX_BYTES),
              ),
            ),
            ref.count,
          );
        const before = await read(old),
          after = await read(next);
        if (
          JSON.stringify(before) !== JSON.stringify(after.slice(0, old.count))
        ) {
          appearance = true;
          break;
        }
      }
    }
    this.root = root;
    this.signature = signature;
    this.etag = response.headers.get("etag");
    return !sameGeneration
      ? "generation"
      : appearance
        ? "appearance"
        : "revision";
  }
  async object(
    ref: ObjectRef,
    signal?: AbortSignal,
    maxBytes = 2 * 1024 * 1024,
  ) {
    return readVerifiedObject({
      url: localAsset(ref.url, this.base),
      sha256: ref.sha256,
      bytes: ref.bytes,
      maxBytes,
      signal,
    });
  }
  async catalog(index: number, signal?: AbortSignal) {
    const page = this.root.catalog[index];
    if (!page) throw Error("Unknown material page");
    return parseCatalog(
      JSON.parse(
        new TextDecoder().decode(
          await this.object(page, signal, MAX_INDEX_BYTES),
        ),
      ),
      page.count,
    );
  }
  private async node(
    ref: { key: TileKey; index: ObjectRef },
    signal?: AbortSignal,
  ): Promise<LodNode> {
    signal?.throwIfAborted();
    const known = this.nodes.get(ref.index.sha256);
    if (known) {
      if (tileId(known.value.key) !== tileId(ref.key))
        throw Error("Cached terrain index identity mismatch");
      this.nodes.delete(ref.index.sha256);
      this.nodes.set(ref.index.sha256, known);
      return known.value;
    }
    // Requests with different cancellation owners are deliberately not joined:
    // canceling a speculative pan must never abort a foreground request.
    const raw = await this.object(ref.index, signal, MAX_INDEX_BYTES);
    const node = parseNode(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)),
      ref.key,
      this.base,
    );
    signal?.throwIfAborted();
    if (!this.nodes.has(ref.index.sha256)) this.nodeBytes += raw.byteLength;
    this.nodes.set(ref.index.sha256, { value: node, bytes: raw.byteLength });
    while (this.nodes.size > 512 || this.nodeBytes > 4 * 1024 * 1024) {
      const first = this.nodes.entries().next().value!;
      this.nodeBytes -= first[1].bytes;
      this.nodes.delete(first[0]);
    }
    return node;
  }
  /** Follow only the ancestor indexes for one requested tile. Null is explicit
   * absent hierarchy coverage, never a swallowed download/parse failure.
   */
  async at(key: TileKey, signal?: AbortSignal): Promise<LodNode | null> {
    if (!this.root) throw Error("Terrain hierarchy not initialized");
    const ancestor = (k: TileKey) =>
      k.level >= key.level &&
      Math.floor(key.x / 2 ** (k.level - key.level)) === k.x &&
      Math.floor(key.z / 2 ** (k.level - key.level)) === k.z;
    let ref = this.root.roots.find((r) => ancestor(r.key));
    while (ref) {
      const node = await this.node(ref, signal);
      if (node.key.level === key.level) return node;
      ref = node.children.find((r) => ancestor(r.key));
    }
    return null;
  }
  get metadataBytes() {
    return this.nodeBytes;
  }
}
