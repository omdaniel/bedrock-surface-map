import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { sha256 } from "../release/oci.mjs";
import { assertNativeOciEvidence } from "../release/collect-oci.mjs";

// Only disposable loopback registries are accepted here. Public release
// publication has a separate approval gate; this helper cannot perform it.
export function localRegistry(value) {
  if (
    !/^127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(value) ||
    Number(value.split(":")[1]) > 65535
  )
    throw Error(
      "synthetic staging requires an explicit IPv4 loopback registry",
    );
  return value;
}

export async function verifiedCandidate(root) {
  const candidate = JSON.parse(
    await readFile(join(root, "oci-candidate.json"), "utf8"),
  );
  assert.equal(candidate.schema_version, 1);
  assert.match(candidate.commit, /^[a-f0-9]{40}$/);
  assert.match(candidate.common_sha256, /^[a-f0-9]{64}$/);
  assert.equal(candidate.native_evidence.length, 2);
  const architectures = new Set();
  for (const native of candidate.native_evidence) {
    const architecture = native.images.runtime.architecture;
    assertNativeOciEvidence(
      {
        schema_version: 1,
        architecture,
        commit: candidate.commit,
        common_sha256: candidate.common_sha256,
        release_sha256: native.images.runtime.release_sha256,
        images: native.images,
      },
      native,
    );
    assert.ok(!architectures.has(architecture));
    architectures.add(architecture);
    for (const name of ["runtime", "gateway"])
      assert.deepEqual(
        candidate.images[name].platforms[architecture],
        native.images[name],
      );
  }
  assert.deepEqual([...architectures].sort(), ["amd64", "arm64"]);
  for (const name of ["runtime", "gateway"]) {
    const rootImage = join(root, name);
    const read = async (path) => {
      const info = await lstat(path);
      assert.ok(
        info.isFile() && !info.isSymbolicLink() && info.size <= 512 * 1024 ** 2,
      );
      return readFile(path);
    };
    const catalog = JSON.parse(await read(join(rootImage, "index.json")));
    assert.equal(catalog.manifests.length, 1);
    const descriptor = catalog.manifests[0];
    assert.equal(descriptor.digest, candidate.images[name].index_digest);
    assert.equal(
      descriptor.mediaType,
      "application/vnd.oci.image.index.v1+json",
    );
    const blobs = join(rootImage, "blobs/sha256");
    let total = 0;
    for (const filename of await readdir(blobs)) {
      assert.match(filename, /^[a-f0-9]{64}$/);
      const bytes = await read(join(blobs, filename));
      assert.equal(sha256(bytes), filename);
      total += bytes.length;
      assert.ok(total <= 2 * 1024 ** 3);
    }
    const indexBytes = await read(join(blobs, descriptor.digest.slice(7)));
    assert.equal(indexBytes.length, descriptor.size);
    const index = JSON.parse(indexBytes);
    assert.equal(index.schemaVersion, 2);
    assert.equal(index.manifests.length, 2);
    assert.deepEqual(
      index.manifests.map((m) => m.platform.architecture).sort(),
      ["amd64", "arm64"],
    );
    for (const manifest of index.manifests) {
      const platform =
        candidate.images[name].platforms[manifest.platform.architecture];
      assert.equal(manifest.platform.os, "linux");
      assert.equal(manifest.digest, platform.manifest_digest);
      const manifestBytes = await read(join(blobs, manifest.digest.slice(7)));
      assert.equal(manifestBytes.length, manifest.size);
      const contents = JSON.parse(manifestBytes);
      assert.equal(contents.config.digest, platform.config_digest);
      const config = JSON.parse(
        await read(join(blobs, contents.config.digest.slice(7))),
      );
      assert.equal(config.architecture, manifest.platform.architecture);
      assert.equal(
        config.config.Labels["org.opencontainers.image.revision"],
        candidate.commit,
      );
      assert.equal(
        config.config.Labels["dev.bedrock-surface-map.common-sha256"],
        candidate.common_sha256,
      );
      assert.equal(
        config.config.Labels["dev.bedrock-surface-map.release-sha256"],
        platform.release_sha256,
      );
      assert.equal(config.config.User, "65532:65532");
      assert.equal(config.config.StopSignal, "SIGTERM");
    }
  }
  return candidate;
}

export async function stageLocalCandidate(root, registry, applicationVersion) {
  localRegistry(registry);
  const candidate = await verifiedCandidate(root);
  const release = {
    schema_version: 1,
    application_version: applicationVersion,
    commit: candidate.commit,
    common_sha256: candidate.common_sha256,
    registry_verified: true,
  };
  for (const name of ["runtime", "gateway"]) {
    const repository = `${registry}/fixture/${name}`;
    execFileSync(
      "skopeo",
      [
        "copy",
        "--all",
        "--preserve-digests",
        "--dest-tls-verify=false",
        `oci:${join(root, name)}:candidate`,
        `docker://${repository}:candidate`,
      ],
      { stdio: "inherit", timeout: 180_000 },
    );
    const image = candidate.images[name];
    for (const digest of [
      image.index_digest,
      ...Object.values(image.platforms).map((p) => p.manifest_digest),
    ]) {
      const remote = execFileSync(
        "skopeo",
        [
          "inspect",
          "--raw",
          "--tls-verify=false",
          `docker://${repository}@${digest}`,
        ],
        { timeout: 30_000, maxBuffer: 1024 * 1024 },
      );
      assert.equal(
        `sha256:${sha256(remote)}`,
        digest,
        "registry must serve the exact staged manifest bytes",
      );
    }
    release[name] = {
      repository,
      index_digest: image.index_digest,
      manifests: Object.fromEntries(
        Object.entries(image.platforms).map(([arch, value]) => [
          arch,
          value.manifest_digest,
        ]),
      ),
    };
  }
  return { candidate, release };
}
