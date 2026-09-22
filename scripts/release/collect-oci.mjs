import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectOci, sha256 } from "./oci.mjs";

export function assertNativeOciEvidence(build, native) {
  const expectedHost = { amd64: "linux-x64", arm64: "linux-arm64" }[
    build.architecture
  ];
  if (
    !expectedHost ||
    build.schema_version !== 1 ||
    native.schema_version !== 1 ||
    native.ok !== true ||
    native.scope !== "native-packaging-fixture" ||
    native.host !== expectedHost ||
    native.commit !== build.commit ||
    native.common_sha256 !== build.common_sha256 ||
    native.nonroot_bind_permissions !== true ||
    native.signal_exit_zero !== true ||
    native.readiness_without_producer !== true ||
    native.private_read_listeners !== true ||
    !native.docker?.Server?.Version ||
    !native.compose
  )
    throw Error("missing or inconsistent native OCI packaging evidence");
  for (const name of ["runtime", "gateway"]) {
    const image = native.images?.[name],
      expected = build.images?.[name];
    if (
      !image ||
      !expected ||
      !/^sha256:[a-f0-9]{64}$/.test(expected.manifest_digest) ||
      image.manifest_digest !== expected.manifest_digest ||
      image.config_digest !== expected.config_digest ||
      image.architecture !== build.architecture ||
      image.commit !== build.commit ||
      image.common_sha256 !== build.common_sha256 ||
      image.release_sha256 !== build.release_sha256
    )
      throw Error(
        "native OCI evidence does not identify the exact candidate images",
      );
  }
}

export async function collectOci(output, sources) {
  if (sources.length !== 2) throw Error("both native OCI layouts are required");
  const candidates = [];
  for (const source of sources) {
    const build = JSON.parse(
      await readFile(join(source, "oci-build.json"), "utf8"),
    );
    const native = JSON.parse(
      await readFile(join(source, "oci-native-evidence.json"), "utf8"),
    );
    assertNativeOciEvidence(build, native);
    for (const name of ["runtime", "gateway"]) {
      const inspected = await inspectOci(join(source, name), build);
      if (
        inspected.manifest_digest !== build.images[name].manifest_digest ||
        inspected.config_digest !== build.images[name].config_digest
      )
        throw Error("OCI bytes disagree with native execution evidence");
    }
    candidates.push({ source, build, native });
  }
  candidates.sort((a, b) =>
    a.build.architecture.localeCompare(b.build.architecture),
  );
  if (
    candidates.map((item) => item.build.architecture).join(",") !==
      "amd64,arm64" ||
    candidates[0].build.commit !== candidates[1].build.commit ||
    candidates[0].build.common_sha256 !== candidates[1].build.common_sha256
  )
    throw Error(
      "OCI candidates must cover both native architectures and share source/frontend identity",
    );
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output); // Existing output is never replaced.
  const images = {};
  for (const name of ["runtime", "gateway"]) {
    const layout = join(output, name);
    await mkdir(join(layout, "blobs/sha256"), { recursive: true });
    const manifests = [];
    for (const item of candidates) {
      const blobs = join(item.source, name, "blobs/sha256");
      for (const filename of await readdir(blobs)) {
        const destination = join(layout, "blobs/sha256", filename);
        try {
          await copyFile(
            join(blobs, filename),
            destination,
            constants.COPYFILE_EXCL,
          );
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
          if (sha256(await readFile(destination)) !== filename)
            throw Error("conflicting OCI blob");
        }
      }
      const digest = item.build.images[name].manifest_digest;
      manifests.push({
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        digest,
        size: (await lstat(join(blobs, digest.slice(7)))).size,
        platform: { architecture: item.build.architecture, os: "linux" },
      });
    }
    const index = Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: "application/vnd.oci.image.index.v1+json",
        manifests,
      }),
    );
    await writeFile(join(layout, "index.json"), index);
    await writeFile(
      join(layout, "oci-layout"),
      JSON.stringify({ imageLayoutVersion: "1.0.0" }),
    );
    images[name] = {
      index_digest: `sha256:${sha256(index)}`,
      platforms: Object.fromEntries(
        candidates.map((item) => [
          item.build.architecture,
          item.build.images[name],
        ]),
      ),
    };
  }
  const report = {
    schema_version: 1,
    scope: "native-packaging-fixture",
    commit: candidates[0].build.commit,
    common_sha256: candidates[0].build.common_sha256,
    published: false,
    deployment_accepted: false,
    images,
    native_evidence: candidates.map((item) => item.native),
  };
  await writeFile(
    join(output, "oci-candidate.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  return report;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  const [output, ...sources] = process.argv.slice(2);
  if (!output)
    throw Error(
      "usage: collect-oci.mjs <new-output> <amd64-output> <arm64-output>",
    );
  console.log(
    JSON.stringify(
      await collectOci(
        resolve(output),
        sources.map((source) => resolve(source)),
      ),
    ),
  );
}
