# Deployment components

`images/Runtime.Dockerfile` packages the verified native distribution without a
compiler, shell, or package manager. `images/Gateway.Dockerfile` combines a
digest-pinned Caddy image with the same prebuilt frontend. Both images default to
numeric user `65532:65532`; Compose tests override that with the non-root operator's
UID/GID to read owner-only bind-mounted files. Neither image contains credentials.

These components are not yet an operator installation workflow. The deployment
generator, authenticated gateway, BDS handoff and full acceptance gates remain
required before this topology is supported.

## Build and packaging checks

From a clean checkout with an existing verified native archive and common artifact:

```sh
node scripts/release/build-oci.mjs /path/to/native.tar.gz /path/to/common .local/oci/candidate
node scripts/deploy/oci-smoke.mjs .local/oci/candidate
```

The first command requires Docker Buildx with an OCI-capable exporter. It writes
OCI layouts and the actual manifest/config digests, not image tags. The output
directory must not exist. The second command requires rootful Docker Engine,
the Compose plugin, Skopeo and a non-root Linux operator on the candidate's native
architecture. It loads the exact manifests through an ephemeral loopback registry
using `--preserve-digests`; it does not publish to GHCR or modify a firewall.

The packaging fixture tests owner-only tokens, read-only roots, dropped
capabilities, separate unexposed read listeners, empty-server readiness and
SIGTERM shutdown. Its temporary gateway is **not** the authenticated public
deployment. No BDS, public DNS or ACME service is contacted by this fixture.
The test removes only its own Compose project, registry and private scratch.

After both native jobs pass, collect their exact manifests into multi-platform
indexes without rebuilding or publishing:

```sh
node scripts/release/collect-oci.mjs .local/oci/combined /path/to/amd64 /path/to/arm64
```

`oci-candidate.json` binds the resulting index and per-platform digests to the
shared frontend identity and native reports. It explicitly records that image
publication and complete deployment acceptance have not occurred.

`.github/workflows/deployment.yml` builds the common artifact once, then runs
these packaging checks on native Ubuntu AMD64 and ARM64 runners. Its evidence
records Engine/Compose versions and image identities. This is packaging evidence,
not proof of the complete HTTPS/browser or live-BDS acceptance matrix.
