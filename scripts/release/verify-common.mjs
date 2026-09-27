import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  localAsset,
  MAX_INDEX_BYTES,
  MAX_TILE_BYTES,
  parseCatalog,
  parseManifest,
  parseNode,
  parseRef,
  tileBounds,
  tileId,
} from "../../web/src/lod/protocol.ts";
import { childTiles, intersects } from "../../web/src/lod/selection.ts";
import { readBytes } from "../../web/src/lod/root-source.ts";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Validate the exact metadata/object closure; binary codecs remain native. */
export async function verifyLodGraph(bytes, base, readObject) {
  if (bytes.length > MAX_INDEX_BYTES) throw Error("LOD descriptor byte limit");
  const manifest = parseManifest(
    JSON.parse(new TextDecoder().decode(bytes)),
    base,
  );
  const files = new Map(),
    nodes = new Set(),
    materials = [];
  const read = async (value, maximum = MAX_TILE_BYTES) => {
    const ref = parseRef(value, base, maximum);
    const prior = files.get(ref.url);
    if (prior && (prior.bytes !== ref.bytes || prior.sha256 !== ref.sha256))
      throw Error(`conflicting LOD reference: ${ref.url}`);
    const data = await readObject(ref, maximum);
    if (data.length !== ref.bytes || digest(data) !== ref.sha256)
      throw Error(`LOD reference checksum mismatch: ${ref.url}`);
    files.set(ref.url, ref);
    return data;
  };
  const json = (bytes) => JSON.parse(new TextDecoder().decode(bytes));
  await read(manifest.atlas, 32 * 1024 * 1024);
  for (const page of manifest.catalog)
    materials.push(
      ...parseCatalog(json(await read(page, MAX_INDEX_BYTES)), page.count),
    );
  const visit = async (reference) => {
    const id = tileId(reference.key);
    if (nodes.has(id) || nodes.size >= 4096)
      throw Error("duplicate LOD node or smoke fixture node limit");
    nodes.add(id);
    const node = parseNode(
      json(await read(reference.index, MAX_INDEX_BYTES)),
      reference.key,
      base,
    );
    if (!intersects(tileBounds(node.key), manifest.bounds))
      throw Error("LOD node outside fixture bounds");
    if (node.children.length) {
      const expected = childTiles(node.key)
        .filter((key) => intersects(tileBounds(key), manifest.bounds))
        .map(tileId);
      if (
        expected.length !== node.children.length ||
        node.children.some(({ key }) => !expected.includes(tileId(key)))
      )
        throw Error("LOD child coverage mismatch");
    }
    await read(node.data);
    await read(node.height);
    for (const chunk of node.chunks ?? []) await read(chunk, 32768);
    for (const child of node.children) await visit(child);
  };
  for (const reference of manifest.roots) await visit(reference);
  return {
    manifest,
    files: new Set(files.keys()),
    nodes: nodes.size,
    materials,
  };
}

async function verifyFixture(root, declared) {
  const base = new URL("http://127.0.0.1/fixture/");
  const required = async (path, maximum) => {
    const ref = declared.get(`fixture/${path}`);
    if (!ref) throw Error(`missing common fixture reference: ${path}`);
    if (ref.bytes > maximum) throw Error(`common fixture byte limit: ${path}`);
    return readFile(resolve(root, "fixture", path));
  };
  const sourceBytes = await required("manifest.json", MAX_INDEX_BYTES);
  const source = JSON.parse(sourceBytes);
  if (
    source.format_version !== 1 ||
    !Array.isArray(source.regions) ||
    !Array.isArray(source.materials)
  )
    throw Error("unsupported common fixture source");
  const graph = await verifyLodGraph(
    await required("lod.json", MAX_INDEX_BYTES),
    base,
    (ref, maximum) => required(ref.url, maximum),
  );
  const fingerprint = /^[a-fA-F0-9]{64}$/.test(source.source_sha256)
    ? source.source_sha256.toLowerCase()
    : digest(sourceBytes);
  if (
    graph.manifest.source_sha256 !== fingerprint ||
    graph.manifest.world_id !== undefined ||
    graph.manifest.name !== source.name ||
    !isDeepStrictEqual(graph.manifest.bounds, source.bounds) ||
    !isDeepStrictEqual(graph.manifest.spawn, source.spawn) ||
    !isDeepStrictEqual(graph.materials, source.materials)
  )
    throw Error("common fixture source/LOD identity mismatch");
  const allowed = new Set(["manifest.json", "lod.json", ...graph.files]);
  for (const path of [
    source.atlas,
    source.heights,
    ...source.regions.map((region) => region.url),
  ]) {
    const record = declared.get(`fixture/${path}`);
    if (!record) throw Error(`missing common fixture reference: ${path}`);
    parseRef({ ...record, url: path }, base, 32 * 1024 * 1024);
    allowed.add(path);
  }
  if (
    declared.get(`fixture/${source.atlas}`).sha256 !==
    graph.manifest.atlas.sha256
  )
    throw Error("common fixture source/LOD atlas mismatch");
  for (const path of declared.keys())
    if (path.startsWith("fixture/") && !allowed.has(path.slice(8)))
      throw Error(`unreferenced common fixture file: ${path}`);
}

/** Check the configured LOD graph at the viewer mount, including /map/ prefixes. */
export async function verifyServedLod(baseURL, fetchResponse = fetch) {
  const base = new URL(baseURL);
  if (
    !base.pathname.endsWith("/") ||
    base.search ||
    base.hash ||
    base.username ||
    base.password
  )
    throw Error("invalid served LOD mount");
  const asset = (path, relativeTo = base) => {
    const url = new URL(localAsset(path, relativeTo));
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname))
      throw Error("served LOD reference escapes viewer mount");
    return url;
  };
  const read = async (url, maximum) =>
    readBytes(
      await fetchResponse.call(globalThis, url, {
        signal: AbortSignal.timeout(10000),
        redirect: "error",
        cache: "no-cache",
      }),
      maximum,
    );
  const config = JSON.parse(
    new TextDecoder().decode(
      await read(asset("viewer-config.json"), 16 * 1024),
    ),
  );
  if (typeof config.lod_url !== "string" || config.lod_url.length > 512)
    throw Error("served viewer configuration lacks a bounded lod_url");
  const url = asset(config.lod_url);
  if (!url.pathname.endsWith("/lod.json"))
    throw Error("served lod_url is not a LOD descriptor");
  const graph = await verifyLodGraph(
    await read(url, MAX_INDEX_BYTES),
    new URL(".", url),
    (ref, maximum) => read(asset(ref.url, url), maximum),
  );
  return { url: url.href, nodes: graph.nodes, objects: graph.files.size };
}

export async function verifyCommon(root, expectedCommit) {
  if (
    !(await lstat(root)).isDirectory() ||
    (await lstat(root)).isSymbolicLink()
  )
    throw Error("common artifact root must be a real directory");
  const manifest = JSON.parse(
    await readFile(resolve(root, "common-manifest.json"), "utf8"),
  );
  if (
    manifest.schema_version !== 1 ||
    manifest.commit !== expectedCommit ||
    !Array.isArray(manifest.files) ||
    !/^[0-9a-f]{40}$/.test(manifest.commit)
  )
    throw Error("common artifact source identity or schema mismatch");
  const declared = new Map();
  for (const file of manifest.files) {
    if (
      typeof file.path !== "string" ||
      file.path.startsWith("/") ||
      file.path.includes("\\") ||
      /[\x00-\x1f]/.test(file.path) ||
      file.path
        .split("/")
        .some((part) => !part || part === "." || part === "..") ||
      declared.has(file.path) ||
      !/^[0-9a-f]{64}$/.test(file.sha256) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0
    )
      throw Error("invalid common artifact inventory");
    declared.set(file.path, file);
  }
  const found = new Set();
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink())
        throw Error(`common artifact symlink: ${path}`);
      if (stat.isDirectory()) await walk(path);
      else if (stat.isFile()) {
        const key = relative(root, path).split(sep).join("/");
        if (key === "common-manifest.json") continue;
        const record = declared.get(key);
        if (!record) throw Error(`unlisted common artifact file: ${key}`);
        const bytes = await readFile(path);
        if (
          bytes.length !== record.bytes ||
          createHash("sha256").update(bytes).digest("hex") !== record.sha256
        )
          throw Error(`common artifact checksum mismatch: ${key}`);
        found.add(key);
      } else throw Error(`unsupported common artifact entry: ${path}`);
    }
  }
  await walk(root);
  if (found.size !== declared.size) throw Error("missing common artifact file");
  await verifyFixture(root, declared);
  return manifest;
}

export function assertReleaseCommon(common, release) {
  if (common.commit !== release.commit)
    throw Error("common/release source mismatch");
  const files = new Map(release.files.map((record) => [record.path, record]));
  for (const record of common.files) {
    const mapped = record.path.startsWith("fixture/")
      ? `share/bedrock-surface-map/fixtures/surface-v1/${record.path.slice(8)}`
      : record.path.startsWith("terrain-pack/")
        ? `share/bedrock-surface-map/packs/terrain/${record.path.slice(13)}`
        : record.path.startsWith("tracking-pack/")
          ? `share/bedrock-surface-map/packs/tracking/${record.path.slice(14)}`
          : `share/bedrock-surface-map/${record.path}`;
    const bundled = files.get(mapped);
    if (
      !bundled ||
      bundled.sha256 !== record.sha256 ||
      bundled.bytes !== record.bytes
    )
      throw Error(`common resource mismatch: ${record.path}`);
  }
}
