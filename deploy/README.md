# Deployment components

`images/Runtime.Dockerfile` packages the verified native distribution without a
compiler, shell, or package manager. `images/Gateway.Dockerfile` combines a
digest-pinned Caddy image with the same prebuilt frontend. Both images default to
numeric user `65532:65532`; Compose tests override that with the non-root operator's
UID/GID to read owner-only bind-mounted files. Neither image contains credentials.

These components are not yet a supported operator installation workflow. The
generator supplies transactional preparation, an authenticated gateway and a
private BDS handoff. Generated-container, browser, network and actual-BDS acceptance
remain required. Runtime diagnostics and registry publication tooling are incomplete.

## Initialization boundary

`bedrock-map deploy init --dir ./map-deploy --config ./deployment.toml` validates
the separate [deployment schema example](deployment.example.toml), then creates stable world/generation identities,
independent feed credentials and an optional bcrypt viewer hash. Password access
is the default; a hidden TTY prompt or `--viewer-password-file` accepts the secret,
never a password argument. Password files must be operator-owned with mode 0600.
Repeated initialization verifies existing files without rotating credentials.
Missing secrets, changed settings, unsafe ownership and unacknowledged public
access are errors. Snapshot `config.toml` and loopback serving remain separate.

Initialization requires a `deployment-release.json` beside the verified operator
distribution, pairing registry-verified immutable runtime/gateway images with
its exact commit and common resources. The packaging candidate alone is not that
publication record. There is no end-user source-build fallback or image tag.
Deployment preparation and runtime acceptance are separate from initialization;
an initialized directory is not a prepared or running deployment.

## Preparation boundary

With a verified imported snapshot selected in the existing snapshot state:

```sh
bedrock-map deploy prepare --dir ./map-deploy --snapshot-state ./map-data --assets ./bedrock-assets.zip
```

Terrain preparation requires the compatible asset archive, either explicitly with
`--assets` or in the snapshot state's managed cache. Players-only preparation does
not use that argument. The command copies the validated public snapshot, seeds a
new store using the full asset library, and generates the viewer, Caddy and private
BDS handoff together. A same-filesystem rename selects the completed `prepared/`
tree. Neither the source snapshot nor BDS is modified. The ordinary rendered demo
is not a valid substitute for a parsed Bedrock seed.

Repeated preparation verifies identical inputs without reseeding. Changed inputs,
modified immutable outputs and a changed live store are refused. A killed process
may leave private `work/prepare-*` scratch; a retry reports that scratch rather
than selecting it or deleting it automatically. Inspect and remove only the
abandoned preparation directory. Never remove `prepared/` to bypass a refusal.

`compose.yaml` uses exact image digests, non-root UID/GID, narrow required mounts
with missing-source refusal, and independent feed services. Startup validates the
preparation identity and existing seeded database, then execs the native service;
it never imports or seeds. Public files, gateway files, credentials, mutable store
and BDS handoff remain separate. The handoff requires a reviewed module-level
merge into an independently backed-up test world, not a whole-directory overwrite.

## Generated gateway boundary

All files and read APIs require the shared viewer credential in password mode;
responses override upstream caching with `private, no-store`. Explicit public mode
omits authentication and preserves read-service cache headers. Neither mode grants
write access. Only GET/HEAD requests for the packaged frontend inventory, prepared
public inventory and enabled same-world read APIs are routed. Noncanonical paths,
including dot segments, escaped path aliases and doubled separators, are refused
before Caddy's path normalization. Query parameters do not choose upstreams.

Feed proxies have fixed destinations, strip incoming headers other than the
conditional ETag request, and preserve response payload bytes, MIME and ETags.
The gateway has no ingestion route or token, general SPA fallback, public health
details or enabled access log. Test CA certificates belong only to disposable
tests; the production template uses Caddy's automatic public HTTPS.

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
The tested packaging baseline is Docker Engine 28.0.4 and Compose 2.38.2 on
Ubuntu 24.04-class native runners; older versions are not currently verified.

The packaging fixture tests owner-only tokens, read-only roots, dropped
capabilities, separate unexposed read listeners, empty-server readiness and
SIGTERM shutdown. It tests Caddy's low ports and certificate-store writes as the
non-root user, trusting its disposable local CA only inside the test process.
Its temporary gateway is **not** the authenticated public deployment. No BDS,
public DNS or ACME service is contacted, and no OS trust roots are installed.
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
Both jobs also generate a synthetic MCWorld and import it through the real parser
before exercising preparation. Unit fixtures with fabricated image identities
test validation only; they are not evidence that those images exist or run.
The SHA-pinned Caddy validator additionally executes the generated routing policy
over loopback HTTPS for terrain-only, players-only, combined and explicit-public
configurations. It tests authentication, raw traversal, methods, header stripping
and byte/cache integrity. Only the test client's process trusts its disposable CA;
no system trust store, BDS, public DNS or public certificate service is involved.

The generated-runtime jobs stage the combined indexes in an ephemeral loopback
registry and verify the served index and native-manifest bytes. They run the
operator executable from the exact runtime image, import the synthetic parser
fixture, and exercise generated preparation, mounts, readiness, authentication,
feed outage and same-version restart. Only test CA issuance and ephemeral host
port bindings differ from the generated deployment. Evidence identifies those
differences explicitly; this check is not public-certificate, firewall, browser or
actual-BDS acceptance. The local staging helper refuses non-loopback registries.
