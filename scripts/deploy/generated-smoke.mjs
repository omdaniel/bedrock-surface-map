import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sha256 } from "../release/oci.mjs";
import { stageLocalCandidate } from "./stage-oci.mjs";
import { verifyGeneratedBrowser } from "./generated-browser.mjs";

const [candidateArg, fixtureArg, evidenceArg] = process.argv.slice(2);
if (!candidateArg || !fixtureArg || !evidenceArg)
  throw Error(
    "usage: generated-smoke.mjs <combined-oci> <generated-parser-fixture> <new-evidence-file>",
  );
const arch = { x64: "amd64", arm64: "arm64" }[process.arch];
if (
  process.platform !== "linux" ||
  !arch ||
  !process.getuid() ||
  !process.getgid()
)
  throw Error(
    "generated deployment test requires native Linux and a non-root Docker operator",
  );
const fixture = resolve(fixtureArg),
  output = resolve(evidenceArg);
const temp = await mkdtemp(join(tmpdir(), "surface-generated-"));
const project = `surface-generated-${randomBytes(6).toString("hex")}`;
const registry = `${project}-registry`;
const bases = JSON.parse(await readFile("deploy/images/bases.json", "utf8"));
const version = JSON.parse(await readFile("package.json", "utf8")).version;
const execute = (command, args, options = {}) =>
  execFileSync(command, args, {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 8 * 1024 ** 2,
    ...options,
  }).trim();
const docker = (...args) => execute("docker", args);
const deployment = join(temp, "deployment");
const composePath = join(deployment, "compose-test.json");
const compose = (...args) =>
  docker(
    "compose",
    "--project-directory",
    deployment,
    "-f",
    composePath,
    ...args,
  );
let registryStarted = false,
  stackStarted = false,
  copyContainer;
let ca,
  tokens = [],
  password;
async function waitFor(callback) {
  let error;
  for (let i = 0; i < 100; i++) {
    try {
      return await callback();
    } catch (e) {
      error = e;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw error;
}
function https(port, path, authenticated = true) {
  return new Promise((resolveResponse, reject) => {
    const req = httpsRequest(
      {
        hostname: "127.0.0.1",
        port,
        servername: "map.example.test",
        path,
        ca,
        timeout: 5000,
        headers: {
          host: "map.example.test",
          ...(authenticated
            ? {
                authorization: `Basic ${Buffer.from(`map:${password}`).toString("base64")}`,
              }
            : {}),
        },
      },
      (response) => {
        const chunks = [];
        let length = 0;
        response.on("data", (chunk) => {
          length += chunk.length;
          if (length > 8 * 1024 ** 2)
            req.destroy(Error("fixture response exceeds bound"));
          else chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () =>
          resolveResponse({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(Error("HTTPS fixture timeout")));
    req.end();
  });
}
try {
  docker(
    "run",
    "-d",
    "--name",
    registry,
    "-p",
    "127.0.0.1::5000",
    bases.test_registry,
  );
  registryStarted = true;
  const registryPort = JSON.parse(docker("inspect", registry))[0]
    .NetworkSettings.Ports["5000/tcp"][0].HostPort;
  const registryAddress = `127.0.0.1:${registryPort}`;
  await waitFor(async () =>
    assert.equal(
      (
        await fetch(`http://${registryAddress}/v2/`, {
          signal: AbortSignal.timeout(2000),
        })
      ).status,
      200,
    ),
  );
  const { candidate, release } = await stageLocalCandidate(
    resolve(candidateArg),
    registryAddress,
    version,
  );
  const images = {};
  for (const name of ["runtime", "gateway"]) {
    images[name] = `${release[name].repository}@${release[name].index_digest}`;
    docker("pull", images[name]);
    const info = JSON.parse(docker("image", "inspect", images[name]))[0];
    assert.equal(info.Id, candidate.images[name].platforms[arch].config_digest);
    assert.equal(info.Architecture, arch);
  }
  // Run the operator binary extracted from the exact runtime image, not cargo
  // or source-side code. Its release inventory verifies the copied resources.
  const installed = join(temp, "package");
  await mkdir(installed);
  copyContainer = docker("create", images.runtime);
  docker("cp", `${copyContainer}:/opt/bedrock-map/.`, installed);
  docker("rm", copyContainer);
  copyContainer = null;
  await writeFile(
    join(installed, "deployment-release.json"),
    JSON.stringify(release),
    { mode: 0o600 },
  );
  const binary = join(installed, "bedrock-map");
  const resources = join(installed, "share/bedrock-surface-map");
  const state = join(temp, "snapshot");
  const cli = (...args) =>
    JSON.parse(
      execute(
        binary,
        ["--json", "--resources", resources, "--state", state, ...args],
        { cwd: temp },
      ),
    );
  assert.equal(cli("init").ok, true);
  assert.equal(
    cli(
      "import",
      "--input",
      join(fixture, "generated.mcworld"),
      "--assets",
      join(fixture, "assets.zip"),
    ).ok,
    true,
  );
  const hostAddress = Object.values(networkInterfaces())
    .flat()
    .find(
      (a) =>
        a.family === "IPv4" &&
        !a.internal &&
        (/^10\./.test(a.address) ||
          /^192\.168\./.test(a.address) ||
          /^172\.(1[6-9]|2[0-9]|3[01])\./.test(a.address)),
    )?.address;
  if (!hostAddress)
    throw Error(
      "native test runner has no RFC1918 interface for generated private-ingest binding",
    );
  const config = join(temp, "deployment.toml");
  await writeFile(
    config,
    `schema_version=1\nproject='${project}'\npublic_origin='https://map.example.test'\ningest_bind='${hostAddress}'\nbds_source_ipv4='${hostAddress}'\n[features]\nterrain=true\nplayers=true\n`,
    { mode: 0o600 },
  );
  password = randomBytes(24).toString("hex");
  const passwordFile = join(temp, "viewer-password");
  await writeFile(passwordFile, password, { mode: 0o600 });
  assert.equal(
    cli(
      "deploy",
      "init",
      "--dir",
      deployment,
      "--config",
      config,
      "--viewer-password-file",
      passwordFile,
    ).ok,
    true,
  );
  const prepare = () =>
    cli(
      "deploy",
      "prepare",
      "--dir",
      deployment,
      "--snapshot-state",
      state,
      "--assets",
      join(fixture, "assets.zip"),
    );
  assert.equal(prepare().ok, true);
  const markerPath = join(deployment, "prepared/preparation.json");
  const initialMarker = await readFile(markerPath);
  assert.equal(prepare().ok, true);
  assert.ok(initialMarker.equals(await readFile(markerPath)));
  for (const name of ["terrain", "players"])
    tokens.push(
      await readFile(join(deployment, `secrets/${name}.token`), "utf8"),
    );

  // The fixture changes only certificate issuance and host port assignment.
  // Routing, mounts, identities, service launchers and private files are generated.
  // D11 separately covers public issuance and actual network exposure.
  const caddyPath = join(deployment, "prepared/gateway/Caddyfile");
  const caddy = (await readFile(caddyPath, "utf8")).replace(
    "https://map.example.test {",
    "https://map.example.test {\n  tls internal",
  );
  await writeFile(caddyPath, caddy, { mode: 0o600 });
  const marker = JSON.parse(initialMarker);
  marker.immutable_files["gateway/Caddyfile"] = sha256(Buffer.from(caddy));
  await writeFile(markerPath, JSON.stringify(marker), { mode: 0o600 });
  const generated = JSON.parse(
    await readFile(join(deployment, "compose.yaml"), "utf8"),
  );
  for (const [name, service] of Object.entries(generated.services)) {
    for (const port of service.ports) {
      port.published = "0";
      if (name === "gateway") port.host_ip = "127.0.0.1";
    }
  }
  await writeFile(composePath, JSON.stringify(generated), { mode: 0o600 });
  compose("config", "--quiet");
  stackStarted = true;
  compose("up", "-d");
  const inspect = (name) =>
    JSON.parse(docker("inspect", compose("ps", "-aq", name)))[0];
  const containers = {};
  for (const name of ["gateway", "terrain", "players"]) {
    const info = (containers[name] = inspect(name));
    assert.equal(info.Config.User, `${process.getuid()}:${process.getgid()}`);
    assert.equal(info.HostConfig.ReadonlyRootfs, true);
    assert.deepEqual(info.HostConfig.CapDrop, ["ALL"]);
    assert.ok(info.HostConfig.SecurityOpt.includes("no-new-privileges:true"));
    assert.equal(info.HostConfig.Privileged, false);
    assert.equal(info.HostConfig.Memory, 256 * 1024 ** 2);
    assert.ok(info.Mounts.every((m) => m.Source.startsWith(`${deployment}/`)));
    assert.ok(
      !info.HostConfig.PortBindings["8110/tcp"] &&
        !info.HostConfig.PortBindings["8111/tcp"],
    );
    assert.ok(
      !info.Mounts.some((m) =>
        /docker\.sock|bds-handoff|snapshot|worlds/.test(m.Source),
      ),
    );
  }
  ca = await waitFor(() =>
    readFile(
      join(deployment, "caddy-data/caddy/pki/authorities/local/root.crt"),
    ),
  );
  let port = containers.gateway.NetworkSettings.Ports["443/tcp"][0].HostPort;
  await waitFor(async () =>
    assert.equal((await https(port, "/", false)).status, 401),
  );
  const index = await https(port, "/");
  assert.equal(index.status, 200);
  assert.ok(
    index.body.equals(await readFile(join(resources, "web/index.html"))),
  );
  const viewer = JSON.parse((await https(port, "/viewer-config.json")).body);
  assert.equal(viewer.terrain.world_id, marker.world_id);
  assert.equal(viewer.players.world_id, marker.world_id);
  const playerPath = viewer.players.url;
  const terrainStatus = `/api/v1/worlds/${marker.world_id}/terrain/status`;
  const terrainManifest = await waitFor(async () => {
    const response = await https(port, viewer.terrain.url);
    assert.equal(response.status, 200);
    return JSON.parse(response.body);
  });
  assert.ok(terrainManifest.regions.length > 0);
  await waitFor(async () =>
    assert.equal(
      JSON.parse((await https(port, playerPath)).body).status,
      "starting",
    ),
  );
  for (const name of ["terrain", "players"])
    await waitFor(async () =>
      assert.equal(inspect(name).State.Health.Status, "healthy"),
    );
  const now = Date.now();
  const snapshot = {
    schema_version: 1,
    world_id: marker.world_id,
    instance_id: "generated-fixture",
    started_at_ms: now,
    sampled_at_ms: now,
    sequence: 1,
    pack_version: "fixture",
    players: [],
  };
  const ingestPort =
    containers.players.NetworkSettings.Ports["8081/tcp"][0].HostPort;
  const post = (token) =>
    fetch(`http://${hostAddress}:${ingestPort}/ingest/v1/snapshot`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-tracker-token": token },
      body: JSON.stringify(snapshot),
      signal: AbortSignal.timeout(5000),
    });
  assert.equal((await post("wrong")).status, 401);
  assert.equal((await post(tokens[1])).status, 204);
  assert.equal(JSON.parse((await https(port, playerPath)).body).status, "live");
  for (const path of [
    "/healthz",
    "/ingest/v1/snapshot",
    "/deployment-lock.json",
    "/bds-handoff/",
    "/../viewer-config.json",
  ])
    assert.equal((await https(port, path)).status, 404);
  compose("stop", "-t", "5", "terrain");
  assert.equal((await https(port, "/")).status, 200);
  assert.equal(JSON.parse((await https(port, playerPath)).body).status, "live");
  assert.equal((await https(port, terrainStatus)).status, 502);
  compose("start", "terrain");
  await waitFor(async () =>
    assert.equal((await https(port, terrainStatus)).status, 200),
  );
  compose("stop", "-t", "5");
  for (const name of ["gateway", "terrain", "players"])
    assert.equal(inspect(name).State.ExitCode, 0);
  const stable = await readFile(markerPath),
    certificate = await readFile(
      join(deployment, "caddy-data/caddy/pki/authorities/local/root.crt"),
    );
  compose("start");
  // Docker can assign a different ephemeral host port when restarting a stopped
  // container. The supported deployment uses fixed ports; this fixture does not.
  port = inspect("gateway").NetworkSettings.Ports["443/tcp"][0].HostPort;
  await waitFor(async () =>
    assert.equal((await https(port, viewer.terrain.url)).status, 200),
  );
  assert.deepEqual(
    JSON.parse((await https(port, viewer.terrain.url)).body),
    terrainManifest,
  );
  assert.ok(stable.equals(await readFile(markerPath)));
  assert.ok(
    certificate.equals(
      await readFile(
        join(deployment, "caddy-data/caddy/pki/authorities/local/root.crt"),
      ),
    ),
  );
  assert.equal(
    JSON.parse((await https(port, playerPath)).body).status,
    "starting",
  );
  const logs = compose("logs", "--no-color");
  assert.ok([...tokens, password].every((secret) => !logs.includes(secret)));
  const browserEvidence = await verifyGeneratedBrowser({ port, ca, password });
  await writeFile(
    output,
    JSON.stringify(
      {
        schema_version: 1,
        ok: true,
        scope: "generated-native-deployment",
        host: `${process.platform}-${process.arch}`,
        commit: candidate.commit,
        common_sha256: candidate.common_sha256,
        images: candidate.images,
        docker: JSON.parse(docker("version", "--format", "json")),
        compose: docker("compose", "version", "--short"),
        generated_parser_seed: true,
        exact_frontend: true,
        prepared_startup: true,
        private_https: true,
        generated_mounts: true,
        auth_and_fixed_reads: true,
        independent_outage: true,
        restart_without_reseed: true,
        synthetic_transport_changes: [
          "private CA issuer",
          "ephemeral host ports",
          "gateway loopback bind",
        ],
        public_publication: false,
        public_certificate: false,
        browser_verified: true,
        browser_evidence: browserEvidence,
        actual_bds_verified: false,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
} catch (error) {
  if (stackStarted) {
    let logs = compose("logs", "--no-color");
    for (const value of [...tokens, password].filter(Boolean))
      logs = logs.replaceAll(value, "[redacted]");
    console.error(logs);
  }
  throw error;
} finally {
  if (stackStarted) compose("down", "--remove-orphans", "-t", "5");
  if (copyContainer) docker("rm", copyContainer);
  if (registryStarted) docker("rm", "-f", registry);
  await rm(temp, { recursive: true, force: true });
}
