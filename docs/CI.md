# Release CI

GitHub Actions checks source and Pages, and its uncredentialed `native-amd64`
job assembles and tests the exact AMD64 Linux archive on an AMD64 runner.
The optional GitLab pipeline in [`.gitlab-ci.yml`](../.gitlab-ci.yml) builds
the same release scripts on both native Linux architectures after an owner
creates a mirror. Neither source nor native-test jobs publish binary releases.
GitHub retains `native-amd64-<commit>` candidate artifacts for fourteen days;
successful CI does not create a version tag or a GitHub Release. Deployment CI
also validates both native archives; publication requires the protected manual
pipeline below.

Configure these protected GitLab variables before enabling its jobs:

- `BEDROCK_MAP_RELEASE_IMAGE`: a pinned image containing Node 26.8.1, Rust
  1.92.0, `cargo-zigbuild`, Zig 0.15.2, `wasm-bindgen` 0.2.127, and the native
  C/C++ prerequisites for the selected musl targets.
- `BEDROCK_MAP_AMD64_RUNNER_TAG` and `BEDROCK_MAP_ARM64_RUNNER_TAG`: tags for
  native Linux AMD64 and ARM64 runners. ARM execution is required before an
ARM archive is supported.

The separate `Deployment Packaging` workflow builds one common artifact and
packages it into native AMD64 and ARM64 OCI candidates. Its native Docker fixture
checks numeric users, owner-only secret mounts, listener isolation and signal
handling. Generated-runtime jobs exercise the packaged init/prepare/check commands,
real HTTPS/browser terrain and player updates, feed combinations and scoped firewall
packet tests on disposable runners. They install Mesa/Vulkan, Xvfb and xauth for
software WebGPU presentation; browser evidence records its actual adapter.
The workflow validates a reproducible operator wrapper against an ephemeral
loopback registry, then joins both native archive and deployment reports in a
publication dry run. It retains OCI layouts and native/generated evidence for
fourteen days; it publishes neither registry images nor a supported live installer. See
[`deploy/README.md`](../deploy/README.md) for its scope and local commands.

The GitLab jobs are skipped until those protected variables exist. A
cross-compiled archive is build evidence, not native-runtime evidence.
The buildable prerequisite recipe is `ci/release-image/Dockerfile`. Build its
AMD64 and ARM64 variants from a Node base image selected by immutable digest,
publish the image to an operator-controlled registry, and set
`BEDROCK_MAP_RELEASE_IMAGE` to the resulting digest-qualified image reference.
That external registry and the native runners are not provisioned by this
repository. Verify `node --version`, `rustc --version`, `cargo-zigbuild
--version`, `python-zig version`, and `wasm-bindgen --version` on each platform
before assigning the runner tags.

`node ci/release.mjs <target> <common-artifact>` packages and validates one
exact archive. The harness extracts it, uses only the packaged executable and
resources, verifies the loopback HTTP service, and uses Chromium to confirm
the packaged application initializes WebGPU and renders its synthetic terrain
at both `/` and `/map/`. By default, the browser gate runs on the same native
Linux architecture as the archive.

When the native server has no suitable browser, a separate browser host can
run the same smoke script against two loopback tunnels, one serving `/` and
one serving `/map/` from the exact extracted archive. Supply both URLs with
`--external-url` and place the resulting JSON report in the native job as
`BEDROCK_MAP_BROWSER_EVIDENCE_FILE`. The gate checks its archive SHA-256,
source commit, rendered pixels, picking, and both mount paths. The native
server smoke remains mandatory on its own architecture; a cross-host browser
does not count as native runtime execution.

`node scripts/release/publish.mjs --dist <dir>` validates a candidate without
network publication. `--publish` additionally requires the matching protected
version tag, `BEDROCK_MAP_PUBLISH_APPROVED=true`, and a protected GitHub token.
Merge-request pipelines cannot publish. Creating a GitLab mirror, runners, and
credentials is an owner operation; this repository does not provision them.

`node ci/collect-release.mjs <candidate-dir> <amd64-dist> <arm64-dist>` combines
the two native job artifacts before the release validation/publisher runs. It
requires duplicate source archives and embedded common-resource manifests to
be byte-identical, checks common-file hashes and source identity, and requires
native smoke and browser evidence bound to each exact archive SHA-256. The
dry run rejects missing evidence; it does not upload anything.

## Deployment Publication

Add `--deployment <combined-oci-dir>` to the same publisher for a deployment
release. Supply `oci-candidate.json`, the verified `runtime/` and `gateway/` OCI
layouts, and `generated-amd64.json` / `generated-arm64.json` from the generated
runtime gates. All reports, native archives, image labels and common resources
must identify the same commit and bytes. A clean staging directory is required;
do not mix artifacts from different workflow runs.

The optional GitLab manual jobs select that directory with the protected
`BEDROCK_MAP_DEPLOYMENT_CANDIDATE` variable. Its OCI layouts and generated reports
must be staged as job inputs by the release operator; the jobs do not implicitly
download a recent GitHub run or rebuild missing images. Leave the variable unset
for the snapshot-only path. The publisher refuses native archives that differ
from those recorded in the OCI evidence, including rebuilds with different bytes.

The protected manual job needs `skopeo`, GNU tar/gzip, and an operator-owned
mode-0600 registry auth file selected with `BEDROCK_MAP_REGISTRY_AUTH_FILE`.
Use the registry tool's stdin/login mechanism to create it; never put passwords
in arguments or source. The publisher copies both full OCI indexes with digest
preservation to the two `ghcr.io/omdaniel/bedrock-surface-map-{runtime,gateway}`
packages and verifies anonymous TLS reads of the exact index/platform manifests.
Those packages must be owner-configured as public; failure stops operator-bundle
publication rather than distributing private/unavailable image references.

Only after verification does it assemble architecture-specific operator bundles
containing the unchanged native archive and adjacent `deployment-release.json`.
The GitHub Release includes their checksums and source-bound deployment evidence.
The snapshot-only publishing path remains available without `--deployment`.
Use a fresh staging directory when retrying an interrupted publication. Synthetic
acceptance and public availability do not establish actual-BDS, public-certificate
or external-network acceptance; record those separately before describing the
release as a supported live deployment.
