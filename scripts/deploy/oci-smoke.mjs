import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inspectOci } from "../release/oci.mjs";

const output = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw Error("usage: oci-smoke.mjs <build-oci-output>");
const build = JSON.parse(
  await readFile(join(output, "oci-build.json"), "utf8"),
);
const hostArch = { x64: "amd64", arm64: "arm64" }[process.arch];
if (process.platform !== "linux" || hostArch !== build.architecture)
  throw Error(
    "container acceptance requires a native Linux host matching the candidate",
  );
const uid = process.getuid(),
  gid = process.getgid();
if (!uid || !gid)
  throw Error("run native acceptance as a non-root Docker operator");
const temp = await mkdtemp(join(tmpdir(), "surface-oci-smoke-"));
const project = `surface-fixture-${randomBytes(6).toString("hex")}`;
const registry = `${project}-registry`;
const bases = JSON.parse(await readFile("deploy/images/bases.json", "utf8"));
const docker = (...args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  }).trim();
const compose = (...args) =>
  docker(
    "compose",
    "--project-directory",
    temp,
    "-f",
    join(temp, "compose.json"),
    ...args,
  );
let composeStarted = false,
  registryStarted = false;
async function request(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(5000) });
}
async function waitFor(run) {
  let error;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      return await run();
    } catch (e) {
      error = e;
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  throw error;
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
    assert.equal((await request(`http://${registryAddress}/v2/`)).status, 200),
  );
  const images = {};
  for (const name of ["runtime", "gateway"]) {
    const report = await inspectOci(join(output, name), build);
    assert.equal(report.manifest_digest, build.images[name].manifest_digest);
    const tag = `${registryAddress}/fixture/${name}:candidate`;
    execFileSync(
      "skopeo",
      [
        "copy",
        "--preserve-digests",
        "--dest-tls-verify=false",
        `oci:${join(output, name)}`,
        `docker://${tag}`,
      ],
      { stdio: "inherit", timeout: 120_000 },
    );
    images[name] =
      `${registryAddress}/fixture/${name}@${report.manifest_digest}`;
    docker("pull", images[name]);
    const info = JSON.parse(docker("image", "inspect", images[name]))[0];
    assert.equal(info.Id, report.config_digest);
    assert.equal(info.Architecture, hostArch);
  }
  for (const dir of ["secrets", "terrain", "caddy-data", "caddy-config"])
    await mkdir(join(temp, dir), { mode: 0o700 });
  const token = randomBytes(32).toString("hex");
  for (const name of ["terrain", "players"])
    await writeFile(join(temp, "secrets", name), token, { mode: 0o600 });
  // This is a packaging fixture, not the operator's authenticated deployment.
  // Only its disposable gateway and ingest listeners are reachable on loopback.
  await writeFile(
    join(temp, "Caddyfile"),
    `{
  admin off
  auto_https off
}
:80 {
  route {
    @reads path /api/v1/worlds/fixture-world/players
    reverse_proxy @reads players:8110
    @terrain path /api/v1/worlds/fixture-world/terrain/status
    reverse_proxy @terrain terrain:8111
    @index path /
    handle @index {
      root * /opt/bedrock-map/web
      file_server
    }
    respond 404
  }
}
`,
    { mode: 0o600 },
  );
  const bind = (source, target, read_only = true) => ({
    type: "bind",
    source: join(temp, source),
    target,
    read_only,
    bind: { create_host_path: false },
  });
  const hardening = {
    user: `${uid}:${gid}`,
    read_only: true,
    cap_drop: ["ALL"],
    security_opt: ["no-new-privileges:true"],
    restart: "unless-stopped",
    pids_limit: 64,
    mem_limit: "256m",
    cpus: 0.5,
    logging: {
      driver: "json-file",
      options: { "max-size": "1m", "max-file": "2" },
    },
  };
  const published = (target) => ({
    target,
    published: "0",
    host_ip: "127.0.0.1",
    protocol: "tcp",
  });
  const healthcheck = (service) => ({
    test: ["CMD", "/opt/bedrock-map/bedrock-map", "internal-health", service],
    interval: "5s",
    timeout: "3s",
    start_period: "2s",
    retries: 3,
  });
  const config = {
    name: project,
    services: {
      gateway: {
        ...hardening,
        image: images.gateway,
        ports: [published(80)],
        volumes: [
          bind("Caddyfile", "/etc/bedrock-map/Caddyfile"),
          bind("caddy-data", "/data", false),
          bind("caddy-config", "/config", false),
        ],
      },
      terrain: {
        ...hardening,
        healthcheck: healthcheck("terrain"),
        image: images.runtime,
        command: [
          "/opt/bedrock-map/libexec/surface-sync",
          "--state",
          "/state",
          "--world",
          "fixture-world",
          "--generation",
          "fixture-generation",
          "serve",
          "--token-file",
          "/run/secrets/terrain",
          "--ingest",
          "0.0.0.0:8082",
          "--read",
          "0.0.0.0:8111",
        ],
        ports: [published(8082)],
        volumes: [
          bind("terrain", "/state", false),
          bind("secrets/terrain", "/run/secrets/terrain"),
        ],
      },
      players: {
        ...hardening,
        healthcheck: healthcheck("players"),
        image: images.runtime,
        command: ["/opt/bedrock-map/libexec/surface-tracker"],
        environment: {
          TRACKER_TOKEN_FILE: "/run/secrets/players",
          TRACKER_WORLD_ID: "fixture-world",
          TRACKER_INGEST_BIND: "0.0.0.0:8081",
          TRACKER_READ_BIND: "0.0.0.0:8110",
        },
        ports: [published(8081)],
        volumes: [bind("secrets/players", "/run/secrets/players")],
      },
    },
  };
  await writeFile(join(temp, "compose.json"), JSON.stringify(config, null, 2));
  compose("config", "--quiet");
  composeStarted = true;
  compose("up", "-d");
  const containers = {};
  for (const name of Object.keys(config.services)) {
    const id = compose("ps", "-q", name);
    const info = JSON.parse(docker("inspect", id))[0];
    containers[name] = info;
    assert.equal(info.Config.User, `${uid}:${gid}`);
    assert.equal(info.HostConfig.ReadonlyRootfs, true);
    assert.deepEqual(info.HostConfig.CapDrop, ["ALL"]);
    assert.ok(info.HostConfig.SecurityOpt.includes("no-new-privileges:true"));
    assert.equal(info.HostConfig.Privileged, false);
    assert.equal(info.HostConfig.Memory, 256 * 1024 * 1024);
    assert.ok(info.Mounts.every((m) => m.Source.startsWith(`${temp}/`)));
    assert.ok(
      info.Mounts.every((m) => m.Destination !== "/var/run/docker.sock"),
    );
    for (const published of Object.values(info.HostConfig.PortBindings))
      assert.ok(published.every((item) => item.HostIp === "127.0.0.1"));
    assert.ok(
      !info.HostConfig.PortBindings["8110/tcp"] &&
        !info.HostConfig.PortBindings["8111/tcp"],
    );
  }
  const port = (name, containerPort) =>
    containers[name].NetworkSettings.Ports[`${containerPort}/tcp`][0].HostPort;
  const gateway = `http://127.0.0.1:${port("gateway", 80)}`;
  await waitFor(async () =>
    assert.match(await (await request(gateway)).text(), /Bedrock Surface Map/),
  );
  const roster = `${gateway}/api/v1/worlds/fixture-world/players`;
  await waitFor(async () =>
    assert.equal((await (await request(roster)).json()).status, "starting"),
  );
  assert.ok(
    (await request(`${gateway}/api/v1/worlds/fixture-world/terrain/status`)).ok,
  );
  for (const name of ["terrain", "players"])
    await waitFor(async () => {
      assert.equal(
        JSON.parse(docker("inspect", containers[name].Id))[0].State.Health
          .Status,
        "healthy",
      );
    });
  const now = Date.now();
  const snapshot = {
    schema_version: 1,
    world_id: "fixture-world",
    instance_id: "oci-fixture",
    started_at_ms: now,
    sequence: 1,
    sampled_at_ms: now,
    pack_version: "test",
    players: [],
  };
  const post = (given) =>
    request(`http://127.0.0.1:${port("players", 8081)}/ingest/v1/snapshot`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-tracker-token": given },
      body: JSON.stringify(snapshot),
    });
  assert.equal((await post("wrong")).status, 401);
  assert.equal((await post(token)).status, 204);
  assert.equal((await (await request(roster)).json()).status, "live");
  assert.equal(
    (await request(`${gateway}/ingest/v1/snapshot`, { method: "POST" })).status,
    404,
  );
  assert.equal((await request(`${gateway}/healthz`)).status, 404);
  const denied = docker(
    "exec",
    containers.gateway.Id,
    "sh",
    "-c",
    "test ! -e /run/secrets/terrain && test ! -e /run/secrets/players && test ! -e /state && ! touch /opt/cannot-write",
  );
  assert.equal(denied, "");
  const effective = docker(
    "exec",
    containers.gateway.Id,
    "cat",
    "/proc/1/status",
  );
  assert.match(effective, /CapEff:\s+0000000000000000/);
  assert.match(effective, /NoNewPrivs:\s+1/);
  compose("stop", "-t", "5");
  for (const info of Object.values(containers)) {
    const stopped = JSON.parse(docker("inspect", info.Id))[0];
    assert.equal(stopped.State.Running, false);
    assert.equal(
      stopped.State.ExitCode,
      0,
      "SIGTERM must reach the daemon, not time out into SIGKILL",
    );
  }
  const log = compose("logs", "--no-color");
  assert.ok(!log.includes(token));
  // A secret unreadable by the runtime UID must fail, not become world-readable.
  await chmod(join(temp, "secrets/players"), 0o000);
  compose("up", "-d", "players");
  await waitFor(async () => {
    const failed = JSON.parse(docker("inspect", containers.players.Id))[0];
    assert.notEqual(failed.State.ExitCode, 0);
  });
  compose("stop", "-t", "5", "players");
  await chmod(join(temp, "secrets/players"), 0o600);
  const evidence = {
    schema_version: 1,
    ok: true,
    scope: "native-packaging-fixture",
    commit: build.commit,
    common_sha256: build.common_sha256,
    host: `${process.platform}-${process.arch}`,
    images: build.images,
    docker: JSON.parse(docker("version", "--format", "json")),
    compose: docker("compose", "version", "--short"),
    nonroot_bind_permissions: true,
    signal_exit_zero: true,
    readiness_without_producer: true,
    private_read_listeners: true,
    no_public_publication: true,
  };
  await writeFile(
    join(output, "oci-native-evidence.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log(JSON.stringify(evidence));
} finally {
  if (composeStarted) compose("down", "--remove-orphans", "-t", "5");
  if (registryStarted) docker("rm", "-f", registry);
  await rm(temp, { recursive: true, force: true });
}
