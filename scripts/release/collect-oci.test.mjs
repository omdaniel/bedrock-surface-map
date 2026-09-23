import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertNativeOciEvidence, collectOci } from "./collect-oci.mjs";
import { inspectOci, sha256 } from "./oci.mjs";
import { localRegistry, verifiedCandidate } from "../deploy/stage-oci.mjs";

test("synthetic image staging cannot publish to an external registry", () => {
  assert.equal(localRegistry("127.0.0.1:43210"), "127.0.0.1:43210");
  for (const value of [
    "ghcr.io",
    "127.0.0.1:65536",
    "127.0.0.1:0",
    "localhost:5000",
    "127.0.0.1:5000/elsewhere",
    "127.0.0.1.evil.test:5000",
  ])
    assert.throws(() => localRegistry(value), /loopback/);
});

function fixture() {
  const identity = {
    architecture: "amd64",
    commit: "a".repeat(40),
    common_sha256: "b".repeat(64),
    release_sha256: "c".repeat(64),
  };
  const image = {
    ...identity,
    manifest_digest: `sha256:${"d".repeat(64)}`,
    config_digest: `sha256:${"e".repeat(64)}`,
  };
  const build = {
    schema_version: 1,
    ...identity,
    images: { runtime: image, gateway: image },
  };
  const native = {
    schema_version: 1,
    ...identity,
    ok: true,
    scope: "native-packaging-fixture",
    host: "linux-x64",
    images: structuredClone(build.images),
    nonroot_bind_permissions: true,
    signal_exit_zero: true,
    private_ca_https: true,
    unprivileged_low_ports: true,
    readiness_without_producer: true,
    private_read_listeners: true,
    docker: { Server: { Version: "fixture" } },
    compose: "fixture",
  };
  return { build, native };
}
test("native OCI gate requires execution, permissions, signals and exact images", () => {
  const { build, native } = fixture();
  assertNativeOciEvidence(build, native);
  for (const key of [
    "ok",
    "nonroot_bind_permissions",
    "signal_exit_zero",
    "private_ca_https",
    "unprivileged_low_ports",
    "readiness_without_producer",
    "private_read_listeners",
  ])
    assert.throws(
      () => assertNativeOciEvidence(build, { ...native, [key]: false }),
      /evidence/,
    );
  for (const host of ["darwin-arm64", "linux-arm64", "emulated-amd64"])
    assert.throws(
      () => assertNativeOciEvidence(build, { ...native, host }),
      /evidence/,
    );
  native.images.runtime.manifest_digest = `sha256:${"f".repeat(64)}`;
  assert.throws(
    () => assertNativeOciEvidence(build, native),
    /exact candidate/,
  );
});
test("native OCI evidence cannot substitute a different archive/common/frontend", () => {
  for (const field of [
    "release_sha256",
    "common_sha256",
    "commit",
    "architecture",
  ]) {
    const { build, native } = fixture();
    native.images.gateway[field] = "different";
    assert.throws(
      () => assertNativeOciEvidence(build, native),
      /exact candidate/,
    );
  }
});

async function nativeFixture(root, architecture) {
  const { build, native } = fixture();
  build.architecture = architecture;
  for (const name of ["runtime", "gateway"]) {
    const layout = join(root, name);
    await mkdir(join(layout, "blobs/sha256"), { recursive: true });
    async function blob(value, suffix) {
      const bytes = Buffer.from(JSON.stringify(value));
      const digest = `sha256:${sha256(bytes)}`;
      await writeFile(join(layout, "blobs/sha256", digest.slice(7)), bytes);
      return {
        mediaType: `application/vnd.oci.image.${suffix}`,
        size: bytes.length,
        digest,
      };
    }
    const config = await blob(
      {
        os: "linux",
        architecture,
        config: {
          User: "65532:65532",
          StopSignal: "SIGTERM",
          Labels: {
            "org.opencontainers.image.revision": build.commit,
            "dev.bedrock-surface-map.common-sha256": build.common_sha256,
            "dev.bedrock-surface-map.release-sha256": build.release_sha256,
          },
        },
      },
      "config.v1+json",
    );
    const manifest = await blob(
      {
        schemaVersion: 2,
        config,
        layers: [await blob("shared-synthetic-layer", "layer.v1.tar+gzip")],
      },
      "manifest.v1+json",
    );
    await writeFile(
      join(layout, "index.json"),
      JSON.stringify({ schemaVersion: 2, manifests: [manifest] }),
    );
    await writeFile(
      join(layout, "oci-layout"),
      JSON.stringify({ imageLayoutVersion: "1.0.0" }),
    );
    build.images[name] = await inspectOci(layout, {
      architecture,
      commit: build.commit,
      common_sha256: build.common_sha256,
      release_sha256: build.release_sha256,
    });
  }
  native.host = architecture === "amd64" ? "linux-x64" : "linux-arm64";
  native.images = structuredClone(build.images);
  await writeFile(join(root, "oci-build.json"), JSON.stringify(build));
  await writeFile(
    join(root, "oci-native-evidence.json"),
    JSON.stringify(native),
  );
  return build;
}

test("multi-architecture OCI index references exact natively checked manifests", async () => {
  const root = await mkdtemp(join(tmpdir(), "oci-collect-"));
  try {
    const amd = join(root, "amd"),
      arm = join(root, "arm");
    const amdBuild = await nativeFixture(amd, "amd64");
    const armBuild = await nativeFixture(arm, "arm64");
    const output = join(root, "candidate");
    const report = await collectOci(output, [arm, amd]);
    assert.equal(report.published, false);
    assert.equal(report.deployment_accepted, false);
    assert.deepEqual(await verifiedCandidate(output), report);
    for (const name of ["runtime", "gateway"]) {
      const catalog = JSON.parse(
        await readFile(join(output, name, "index.json")),
      );
      assert.equal(catalog.manifests.length, 1);
      assert.equal(
        catalog.manifests[0].digest,
        report.images[name].index_digest,
      );
      assert.equal(
        catalog.manifests[0].annotations["org.opencontainers.image.ref.name"],
        "candidate",
      );
      const bytes = await readFile(
        join(
          output,
          name,
          "blobs/sha256",
          catalog.manifests[0].digest.slice(7),
        ),
      );
      assert.equal(report.images[name].index_digest, `sha256:${sha256(bytes)}`);
      const index = JSON.parse(bytes);
      assert.deepEqual(
        index.manifests.map((item) => item.platform.architecture),
        ["amd64", "arm64"],
      );
      assert.deepEqual(
        index.manifests.map((item) => item.digest),
        [
          amdBuild.images[name].manifest_digest,
          armBuild.images[name].manifest_digest,
        ],
      );
    }
    await assert.rejects(collectOci(output, [amd, arm]), /EEXIST/);
    await assert.rejects(
      collectOci(join(root, "duplicates"), [amd, amd]),
      /both native architectures/,
    );
    const native = JSON.parse(
      await readFile(join(arm, "oci-native-evidence.json"), "utf8"),
    );
    native.signal_exit_zero = false;
    await writeFile(
      join(arm, "oci-native-evidence.json"),
      JSON.stringify(native),
    );
    await assert.rejects(
      collectOci(join(root, "bad-evidence"), [amd, arm]),
      /evidence/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
