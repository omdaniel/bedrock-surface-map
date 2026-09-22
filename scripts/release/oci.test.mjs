import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inspectOci, sha256 } from "./oci.mjs";
import { assertReleaseCommon } from "./verify-common.mjs";

const identity = {
  architecture: "arm64",
  commit: "1".repeat(40),
  common_sha256: "2".repeat(64),
  release_sha256: "3".repeat(64),
};
const type = (suffix) => `application/vnd.oci.image.${suffix}`;
async function fixture(run, change = () => {}) {
  const root = await mkdtemp(join(tmpdir(), "oci-test-"));
  await mkdir(join(root, "blobs/sha256"), { recursive: true });
  async function blob(value, mediaType) {
    const bytes = Buffer.from(JSON.stringify(value));
    const digest = `sha256:${sha256(bytes)}`;
    await writeFile(join(root, "blobs/sha256", digest.slice(7)), bytes);
    return { mediaType, digest, size: bytes.length };
  }
  try {
    const config = {
      os: "linux",
      architecture: identity.architecture,
      config: {
        User: "65532:65532",
        StopSignal: "SIGTERM",
        Labels: {
          "org.opencontainers.image.revision": identity.commit,
          "dev.bedrock-surface-map.common-sha256": identity.common_sha256,
          "dev.bedrock-surface-map.release-sha256": identity.release_sha256,
        },
      },
    };
    change(config);
    const layer = await blob(
      "synthetic-opaque-layer",
      type("layer.v1.tar+gzip"),
    );
    const descriptor = await blob(
      {
        schemaVersion: 2,
        mediaType: type("manifest.v1+json"),
        config: await blob(config, type("config.v1+json")),
        layers: [layer],
      },
      type("manifest.v1+json"),
    );
    await writeFile(
      join(root, "oci-layout"),
      JSON.stringify({ imageLayoutVersion: "1.0.0" }),
    );
    await writeFile(
      join(root, "index.json"),
      JSON.stringify({ schemaVersion: 2, manifests: [descriptor] }),
    );
    await run(root, descriptor, layer);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("OCI identity uses manifest bytes, architecture and common identity", () =>
  fixture(async (root, descriptor) => {
    const report = await inspectOci(root, identity);
    assert.equal(report.manifest_digest, descriptor.digest);
    assert.equal(report.architecture, "arm64");
    await assert.rejects(
      inspectOci(root, { ...identity, architecture: "amd64" }),
      /architecture/,
    );
    await assert.rejects(
      inspectOci(root, { ...identity, common_sha256: "4".repeat(64) }),
      /identity/,
    );
  }));
test("OCI rejects corrupt, missing, symlinked or unlisted blobs", async () => {
  for (const kind of ["corrupt", "missing", "link", "extra"])
    await fixture(async (root, descriptor, layer) => {
      const path = join(root, "blobs/sha256", layer.digest.slice(7));
      if (kind === "corrupt") await writeFile(path, Buffer.alloc(layer.size));
      if (kind === "missing" || kind === "link") await rm(path);
      if (kind === "link") await symlink("/etc/passwd", path);
      if (kind === "extra")
        await writeFile(join(root, "private-token"), "canary");
      await assert.rejects(inspectOci(root, identity));
    });
});
test("OCI refuses root defaults and incorrect stop signals", async () => {
  for (const change of [
    (config) => {
      config.config.User = "0:0";
    },
    (config) => {
      config.config.StopSignal = "SIGKILL";
    },
  ])
    await fixture(async (root) => {
      await assert.rejects(inspectOci(root, identity), /non-root/);
    }, change);
});
test("OCI refuses multiple architectures in native evidence", () =>
  fixture(async (root, descriptor) => {
    await writeFile(
      join(root, "index.json"),
      JSON.stringify({ schemaVersion: 2, manifests: [descriptor, descriptor] }),
    );
    await assert.rejects(inspectOci(root, identity), /exactly one/);
  }));
test("release/common comparison verifies contents, not only manifest identity", () => {
  const common = {
    commit: identity.commit,
    files: [{ path: "web/index.html", sha256: "a".repeat(64), bytes: 12 }],
  };
  const release = {
    commit: identity.commit,
    files: [
      {
        path: "share/bedrock-surface-map/web/index.html",
        sha256: "a".repeat(64),
        bytes: 12,
      },
    ],
  };
  assertReleaseCommon(common, release);
  release.files[0].bytes++;
  assert.throws(
    () => assertReleaseCommon(common, release),
    /common resource mismatch/,
  );
});
test("gateway base pin matches the reviewed source lock", async () => {
  const bases = JSON.parse(await readFile("deploy/images/bases.json", "utf8"));
  const dockerfile = await readFile("deploy/images/Gateway.Dockerfile", "utf8");
  assert.equal(dockerfile.split("\n")[0], `FROM ${bases.gateway.image}`);
  assert.deepEqual(Object.keys(bases.gateway.platforms).sort(), [
    "amd64",
    "arm64",
  ]);
  assert.match(bases.test_registry, /@sha256:[a-f0-9]{64}$/);
});
