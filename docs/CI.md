# Release CI

GitHub Actions remains the source and Pages pipeline. The optional GitLab
pipeline in [`.gitlab-ci.yml`](../.gitlab-ci.yml) builds the same release
scripts on native Linux runners after an owner creates a mirror.

Configure these protected GitLab variables before enabling its jobs:

- `BEDROCK_MAP_RELEASE_IMAGE`: a pinned image containing Node 26.8.1, Rust
  1.92.0, `cargo-zigbuild`, Zig 0.15.2, `wasm-bindgen` 0.2.127, and the native
  C/C++ prerequisites for the selected musl targets.
- `BEDROCK_MAP_AMD64_RUNNER_TAG` and `BEDROCK_MAP_ARM64_RUNNER_TAG`: tags for
  native Linux AMD64 and ARM64 runners. ARM execution is required before an
  ARM archive is supported.

The release jobs are intentionally skipped until those variables exist. A
cross-compiled archive is build evidence, not native-runtime evidence.

`node ci/release.mjs <target>` packages and smokes one exact archive. The
smoke harness extracts it, uses only the packaged executable and resources,
and verifies the loopback HTTP service.

`node scripts/release/publish.mjs --dist <dir>` validates a candidate without
network publication. `--publish` additionally requires the matching protected
version tag, `BEDROCK_MAP_PUBLISH_APPROVED=true`, and a protected GitHub token.
Merge-request pipelines cannot publish. Creating a GitLab mirror, runners, and
credentials is an owner operation; this repository does not provision them.

`node ci/collect-release.mjs <candidate-dir> <amd64-dist> <arm64-dist>` combines
the two native job artifacts before the release validation/publisher runs.
