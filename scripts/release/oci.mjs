import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
const indexType = "application/vnd.oci.image.index.v1+json";
const manifestType = "application/vnd.oci.image.manifest.v1+json";
const configType = "application/vnd.oci.image.config.v1+json";
const layerType = "application/vnd.oci.image.layer.v1.tar+gzip";

// Inspect the exact exported bytes, not a mutable local tag or Docker image ID.
export async function inspectOci(root, expected) {
  const found = new Set();
  async function walk(directory) {
    if (!(await lstat(directory)).isDirectory())
      throw Error("OCI root is not a directory");
    for (const entry of await readdir(directory)) {
      const path = join(directory, entry),
        stat = await lstat(path);
      if (stat.isSymbolicLink()) throw Error("OCI symlinks are forbidden");
      if (stat.isDirectory()) await walk(path);
      else if (stat.isFile()) found.add(relative(root, path));
      else throw Error("unsupported OCI entry");
    }
  }
  await walk(root);
  if (
    JSON.parse(await readFile(join(root, "oci-layout"), "utf8"))
      .imageLayoutVersion !== "1.0.0"
  )
    throw Error("unsupported OCI layout");
  const used = new Set(["index.json", "oci-layout"]);
  let total = 0;
  async function blob(descriptor, mediaType) {
    if (
      !descriptor ||
      !/^sha256:[a-f0-9]{64}$/.test(descriptor.digest) ||
      descriptor.mediaType !== mediaType ||
      !Number.isSafeInteger(descriptor.size) ||
      descriptor.size < 0 ||
      descriptor.size > 512 * 1024 * 1024 ||
      descriptor.urls
    )
      throw Error("invalid OCI descriptor");
    const path = `blobs/sha256/${descriptor.digest.slice(7)}`;
    const stat = await lstat(join(root, path));
    if (!stat.isFile() || stat.size !== descriptor.size)
      throw Error("OCI blob size mismatch");
    const bytes = await readFile(join(root, path));
    if (`sha256:${sha256(bytes)}` !== descriptor.digest)
      throw Error("OCI blob hash mismatch");
    if (!used.has(path)) total += bytes.length;
    if (total > 2 * 1024 ** 3) throw Error("OCI image exceeds size bound");
    used.add(path);
    return bytes;
  }
  let index = JSON.parse(await readFile(join(root, "index.json"), "utf8"));
  // BuildKit may wrap its single-platform manifest in an image index.
  for (let depth = 0; depth < 3; depth++) {
    if (
      index.schemaVersion !== 2 ||
      !Array.isArray(index.manifests) ||
      index.manifests.length !== 1
    )
      throw Error("expected exactly one native OCI image");
    const descriptor = index.manifests[0];
    if (descriptor.mediaType !== indexType) break;
    index = JSON.parse(await blob(descriptor, indexType));
  }
  const descriptor = index.manifests?.[0];
  const manifestBytes = await blob(descriptor, manifestType);
  const manifest = JSON.parse(manifestBytes);
  if (
    manifest.schemaVersion !== 2 ||
    !Array.isArray(manifest.layers) ||
    !manifest.layers.length
  )
    throw Error("invalid OCI manifest");
  const config = JSON.parse(await blob(manifest.config, configType));
  for (const layer of manifest.layers) await blob(layer, layerType);
  if (found.size !== used.size || [...found].some((name) => !used.has(name)))
    throw Error("OCI layout contains unlisted content");
  if (config.os !== "linux" || config.architecture !== expected.architecture)
    throw Error("OCI native architecture mismatch");
  const labels = config.config?.Labels ?? {};
  for (const [key, value] of Object.entries({
    "org.opencontainers.image.revision": expected.commit,
    "dev.bedrock-surface-map.common-sha256": expected.common_sha256,
    "dev.bedrock-surface-map.release-sha256": expected.release_sha256,
  }))
    if (!value || labels[key] !== value)
      throw Error(`OCI identity mismatch: ${key}`);
  if (
    config.config.User !== "65532:65532" ||
    config.config.StopSignal !== "SIGTERM"
  )
    throw Error("OCI requires non-root default user and SIGTERM");
  return {
    schema_version: 1,
    ...expected,
    manifest_digest: descriptor.digest,
    config_digest: manifest.config.digest,
    bytes: total,
    layers: manifest.layers.map((layer) => layer.digest),
  };
}
