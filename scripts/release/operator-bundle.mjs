import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { sha256 } from "./oci.mjs";

// Wrap the unchanged, audited native archive and its external image lock. Keeping
// the image lock outside that archive avoids a runtime-image digest cycle.
export async function operatorBundle(archive, release, destination, epoch) {
  assert.equal(release.registry_verified, true);
  assert.match(release.commit, /^[a-f0-9]{40}$/);
  assert.match(release.common_sha256, /^[a-f0-9]{64}$/);
  assert.match(
    release.application_version,
    /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/,
  );
  assert.ok(Number.isSafeInteger(epoch) && epoch > 0);
  const name = basename(archive);
  const architecture = name.match(/-linux-(amd64|arm64)\.tar\.gz$/)?.[1];
  assert.ok(architecture);
  const rootName = `bedrock-surface-map-v${release.application_version}-linux-${architecture}`;
  assert.equal(name, `${rootName}.tar.gz`);
  execFileSync(
    process.execPath,
    ["scripts/release/audit.mjs", resolve(archive)],
    { stdio: "pipe" },
  );
  const embedded = (member) =>
    execFileSync("tar", ["-xOzf", resolve(archive), `${rootName}/${member}`], {
      maxBuffer: 4 * 1024 ** 2,
    });
  const manifest = JSON.parse(embedded("release-manifest.json"));
  assert.equal(manifest.commit, release.commit);
  assert.equal(manifest.application_version, release.application_version);
  assert.equal(
    sha256(
      embedded("share/bedrock-surface-map/provenance/common-manifest.json"),
    ),
    release.common_sha256,
  );
  for (const name of ["runtime", "gateway"]) {
    assert.match(release[name].index_digest, /^sha256:[a-f0-9]{64}$/);
    assert.match(
      release[name].manifests[architecture],
      /^sha256:[a-f0-9]{64}$/,
    );
  }
  const stage = await mkdtemp(join(tmpdir(), "surface-operator-"));
  const bundleName = `bedrock-surface-map-v${release.application_version}-operator-linux-${architecture}`;
  const bundle = join(stage, bundleName);
  try {
    await mkdir(bundle);
    await copyFile(archive, join(bundle, name));
    await writeFile(
      join(bundle, "deployment-release.json"),
      JSON.stringify(release, null, 2) + "\n",
    );
    await writeFile(
      join(bundle, "INSTALL.txt"),
      `Unpack the unchanged native runtime beside this image lock:\n\ntar -xzf ${name} --strip-components=1\n\nRun ./bedrock-map from this directory. Follow docs/DEPLOYMENT.md.\nThe adjacent deployment-release.json pins the registry-verified runtime and gateway.\n`,
    );
    const output = resolve(destination, `${bundleName}.tar.gz`);
    await mkdir(destination, { recursive: true });
    // GNU tar is part of the protected Linux publisher environment.
    const tar = execFileSync(
      "tar",
      [
        "-C",
        stage,
        "--sort=name",
        `--mtime=@${epoch}`,
        "--owner=0",
        "--group=0",
        "--numeric-owner",
        "--format=posix",
        "--pax-option=delete=atime,delete=ctime",
        "-cf",
        "-",
        bundleName,
      ],
      { maxBuffer: 256 * 1024 ** 2 },
    );
    const bytes = execFileSync("gzip", ["-n", "-c"], {
      input: tar,
      maxBuffer: 256 * 1024 ** 2,
    });
    await writeFile(output, bytes, { flag: "wx" });
    return {
      archive: basename(output),
      sha256: sha256(bytes),
      runtime_sha256: sha256(await readFile(archive)),
    };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
