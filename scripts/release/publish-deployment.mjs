import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { verifiedCandidate } from "../deploy/stage-oci.mjs";
import {
  assertGeneratedEvidence,
  authorizePublication,
} from "./deployment-evidence.mjs";
import { sha256 } from "./oci.mjs";
import { operatorBundle } from "./operator-bundle.mjs";

export async function deploymentCandidate(root, dist, version, commit) {
  const candidate = await verifiedCandidate(root);
  assert.equal(candidate.commit, commit);
  const reports = await Promise.all(
    ["amd64", "arm64"].map(async (arch) =>
      JSON.parse(await readFile(join(root, `generated-${arch}.json`), "utf8")),
    ),
  );
  assertGeneratedEvidence(candidate, reports);
  for (const arch of ["amd64", "arm64"]) {
    const bytes = await readFile(
      join(dist, `bedrock-surface-map-v${version}-linux-${arch}.tar.gz`),
    );
    for (const name of ["runtime", "gateway"])
      assert.equal(
        sha256(bytes),
        candidate.images[name].platforms[arch].release_sha256,
        "OCI images must contain the exact tested native archive",
      );
  }
  return candidate;
}

export async function publishDeployment(root, dist, version, commit) {
  authorizePublication(`v${version}`);
  const candidate = await deploymentCandidate(root, dist, version, commit);
  const authfile = process.env.BEDROCK_MAP_REGISTRY_AUTH_FILE;
  if (!authfile)
    throw Error(
      "publication needs a private skopeo auth file, not credentials in arguments",
    );
  const stat = await lstat(authfile);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.mode & 0o077 ||
    stat.uid !== process.getuid()
  )
    throw Error("registry auth file must be operator-owned and private");
  const release = {
    schema_version: 1,
    application_version: version,
    commit,
    common_sha256: candidate.common_sha256,
    registry_verified: true,
  };
  for (const name of ["runtime", "gateway"]) {
    const repository = `ghcr.io/omdaniel/bedrock-surface-map-${name}`;
    const image = candidate.images[name];
    execFileSync(
      "skopeo",
      [
        "copy",
        "--all",
        "--preserve-digests",
        "--dest-tls-verify=true",
        "--dest-authfile",
        resolve(authfile),
        `oci:${join(root, name)}:candidate`,
        `docker://${repository}:sha256-${image.index_digest.slice(7)}`,
      ],
      { stdio: "inherit", timeout: 300_000 },
    );
    // Anonymous reads are intentional: private/unavailable packages cannot
    // produce a downloadable public operator lock.
    for (const digest of [
      image.index_digest,
      ...Object.values(image.platforms).map((p) => p.manifest_digest),
    ]) {
      const bytes = execFileSync(
        "skopeo",
        [
          "inspect",
          "--no-creds",
          "--tls-verify=true",
          "--raw",
          `docker://${repository}@${digest}`,
        ],
        { timeout: 30_000, maxBuffer: 1024 ** 2 },
      );
      assert.equal(
        `sha256:${sha256(bytes)}`,
        digest,
        "registry changed or did not expose the tested manifest",
      );
    }
    release[name] = {
      repository,
      index_digest: image.index_digest,
      manifests: Object.fromEntries(
        Object.entries(image.platforms).map(([arch, p]) => [
          arch,
          p.manifest_digest,
        ]),
      ),
    };
  }
  const epoch = Number(
    execFileSync("git", ["show", "-s", "--format=%ct", commit], {
      encoding: "utf8",
    }).trim(),
  );
  const bundles = [];
  for (const arch of ["amd64", "arm64"])
    bundles.push(
      await operatorBundle(
        join(dist, `bedrock-surface-map-v${version}-linux-${arch}.tar.gz`),
        release,
        dist,
        epoch,
      ),
    );
  await writeFile(
    join(dist, "deployment-release.json"),
    JSON.stringify(release, null, 2) + "\n",
    { flag: "wx" },
  );
  await writeFile(
    join(dist, "DEPLOYMENT_SHA256SUMS"),
    [
      ...bundles.map((b) => `${b.sha256}  ${b.archive}`),
      `${sha256(await readFile(join(dist, "deployment-release.json")))}  deployment-release.json`,
    ].join("\n") + "\n",
    { flag: "wx" },
  );
  await writeFile(
    join(dist, "deployment-evidence.json"),
    JSON.stringify(
      {
        schema_version: 1,
        commit,
        common_sha256: candidate.common_sha256,
        images: candidate.images,
        bundles,
        generated: await Promise.all(
          ["amd64", "arm64"].map(async (a) =>
            JSON.parse(
              await readFile(join(root, `generated-${a}.json`), "utf8"),
            ),
          ),
        ),
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  return [
    ...bundles.map((b) => b.archive),
    "deployment-release.json",
    "DEPLOYMENT_SHA256SUMS",
    "deployment-evidence.json",
  ];
}
