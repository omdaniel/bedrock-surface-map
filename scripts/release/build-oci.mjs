import { execFileSync } from "node:child_process";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { assertReleaseCommon, verifyCommon } from "./verify-common.mjs";
import { inspectOci, sha256 } from "./oci.mjs";
import { currentCommit } from "./validate-tag.mjs";

const [archiveArg, commonArg, outputArg] = process.argv.slice(2);
if (!archiveArg || !commonArg || !outputArg)
  throw Error(
    "usage: build-oci.mjs <verified-native-archive> <common-artifact> <new-output-directory>",
  );
const archive = resolve(archiveArg),
  common = resolve(commonArg),
  output = resolve(outputArg);
const commit = currentCommit();
if (
  execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
    encoding: "utf8",
  }).trim()
)
  throw Error("OCI build requires a clean tracked checkout");
execFileSync(process.execPath, ["scripts/release/audit.mjs", archive], {
  stdio: "inherit",
});
const commonManifest = await verifyCommon(common, commit);
const temp = await mkdtemp(join(tmpdir(), "surface-oci-"));
try {
  const unpack = join(temp, "unpack");
  await mkdir(unpack);
  execFileSync("tar", ["-xzf", archive, "-C", unpack]);
  const entries = await readdir(unpack);
  if (entries.length !== 1) throw Error("native archive root mismatch");
  const source = join(unpack, entries[0]);
  const release = JSON.parse(
    await readFile(join(source, "release-manifest.json"), "utf8"),
  );
  const architecture = {
    "x86_64-unknown-linux-musl": "amd64",
    "aarch64-unknown-linux-musl": "arm64",
  }[release.target];
  if (!architecture || release.commit !== commit)
    throw Error("native release identity mismatch");
  assertReleaseCommon(commonManifest, release);
  const commonBytes = await readFile(join(common, "common-manifest.json"));
  if (
    !commonBytes.equals(
      await readFile(
        join(
          source,
          "share/bedrock-surface-map/provenance/common-manifest.json",
        ),
      ),
    )
  )
    throw Error(
      "native release and supplied frontend are not the same common artifact",
    );
  const identity = {
    commit,
    architecture,
    common_sha256: sha256(commonBytes),
    release_sha256: sha256(await readFile(archive)),
  };
  const context = join(temp, "context");
  await mkdir(context);
  await cp(source, join(context, "runtime"), { recursive: true });
  await mkdir(join(context, "gateway"));
  await cp(join(common, "web"), join(context, "gateway/web"), {
    recursive: true,
  });
  for (const file of ["LICENSE", "THIRD_PARTY.md", "BUILDING.txt"])
    await cp(join(source, file), join(context, "gateway", file));
  await cp(
    join(common, "common-manifest.json"),
    join(context, "gateway/common-manifest.json"),
  );
  // Release resources can be owner-readable on the build host; the image's
  // immutable, non-secret resources must also be readable by the runtime UID.
  async function permissions(directory) {
    await chmod(directory, 0o755);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await permissions(path);
      else
        await chmod(
          path,
          /^(bedrock-map|surface-map|surface-sync|surface-tracker)$/.test(
            basename(path),
          )
            ? 0o755
            : 0o644,
        );
    }
  }
  await permissions(context);
  await mkdir(output); // Never erase an existing candidate or operator directory.
  const reports = {};
  for (const [name, dockerfile] of [
    ["runtime", "Runtime.Dockerfile"],
    ["gateway", "Gateway.Dockerfile"],
  ]) {
    await cp(join("deploy/images", dockerfile), join(context, dockerfile));
    const destination = join(output, name);
    execFileSync(
      "docker",
      [
        "buildx",
        "build",
        "--platform",
        `linux/${architecture}`,
        "--provenance=false",
        "--sbom=false",
        "--file",
        join(context, dockerfile),
        "--build-arg",
        `APPLICATION_COMMIT=${commit}`,
        "--build-arg",
        `COMMON_SHA256=${identity.common_sha256}`,
        "--build-arg",
        `RELEASE_SHA256=${identity.release_sha256}`,
        "--output",
        `type=oci,dest=${destination},tar=false,compression=gzip,force-compression=true`,
        context,
      ],
      { stdio: "inherit", timeout: 15 * 60_000 },
    );
    reports[name] = await inspectOci(destination, identity);
  }
  const report = {
    schema_version: 1,
    ...identity,
    images: reports,
    published: false,
    native_execution: false,
  };
  await writeFile(
    join(output, "oci-build.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
} finally {
  await rm(temp, { recursive: true, force: true });
}
