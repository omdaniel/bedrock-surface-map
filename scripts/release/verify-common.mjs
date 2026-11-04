import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

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
  if (declared.has("web/viewer-config.json")) {
    const bytes = await readFile(resolve(root, "web/viewer-config.json"));
    if (bytes.length > 16 * 1024)
      throw Error("viewer configuration exceeds limit");
    validateOptionalLodConfig(JSON.parse(bytes));
  }
  return manifest;
}

// LOD remains optional; an empty packaged configuration still selects the
// native server's binding. URL checks use the literal input before normalization.
export function validateOptionalLodConfig(config) {
  if (config.terrain && Object.hasOwn(config.terrain, "lod_url"))
    throw Error("lod_url must be top-level, not nested under terrain");
  if (Object.hasOwn(config, "lod_url")) {
    const url = config.lod_url;
    if (
      typeof url !== "string" ||
      url.length > 512 ||
      !/^\/?[A-Za-z0-9_./-]+\.json$/.test(url) ||
      url.includes("//") ||
      url.split("/").some((part) => part === "." || part === "..")
    )
      throw Error("invalid same-origin lod_url");
  }
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
