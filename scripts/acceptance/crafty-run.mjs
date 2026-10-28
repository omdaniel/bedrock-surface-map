import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes, X509Certificate } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stageLocalCandidate } from "../deploy/stage-oci.mjs";
import {
  BDS,
  CRAFTY,
  assertEmptyLive,
  bedrockImport,
  enableDisposableBetaApis,
  inspectBdsLogs,
  requireDisposable,
  sha256,
} from "./crafty-contract.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failureCodes = new Set([
  "ERR_ASSERTION",
  "SUBPROCESS_FAILURE",
  "WAIT_TIMEOUT",
  "ACCEPTANCE_FAILURE",
  "ENOENT",
  "EACCES",
  "ENOBUFS",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "ENOTFOUND",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED",
]);
const failureCode = (error) =>
  failureCodes.has(error?.code) ? error.code : "ACCEPTANCE_FAILURE";

// Fixed classifications only: neither a line, a matched substring, nor an
// exception message is ever retained in the report.
export function classifyPanelLogs(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const count = (pattern) => lines.filter((line) => pattern.test(line)).length;
  return {
    lines_inspected: lines.length,
    wrapper_launch: count(/Wrapper.*Launching crafty/i),
    config_initialization: count(
      /Config not found|Initialization complete|Fresh install detected/i,
    ),
    certificate_generation: count(
      /Generating a self signed SSL|Generating a key pair/i,
    ),
    web_listening: count(
      /Starting Web Server|is up and ready for connections/i,
    ),
    ready: count(/fully started and is now ready for use/i),
    python_tracebacks: count(/Traceback \(most recent call last\)/),
    fatal_errors: count(/\bCRITICAL\b|\bFATAL\b|uncaught|failed to start/i),
    permission_errors: count(
      /PermissionError|permission denied|operation not permitted/i,
    ),
    missing_files: count(/FileNotFoundError|No such file or directory/i),
    missing_modules: count(/ModuleNotFoundError|ImportError|No module named/i),
    certificate_errors: count(
      /SSLError|certificate.*(?:invalid|verify failed)|SSL.*(?:error|fail)/i,
    ),
    network_errors: count(
      /NameResolutionError|Temporary failure in name resolution|Network is unreachable|ConnectionError|Connection(?:Refused|Reset|Aborted)Error|Connection refused|ConnectTimeout|ReadTimeout|timed out/i,
    ),
    port_conflicts: count(/Address already in use|port is already allocated/i),
    storage_errors: count(
      /No space left on device|database is locked|database.*malformed/i,
    ),
  };
}

export function sanitizePanelState(info) {
  const states = new Set([
    "created",
    "running",
    "paused",
    "restarting",
    "removing",
    "exited",
    "dead",
  ]);
  return {
    exists: true,
    status: states.has(info.State?.Status) ? info.State.Status : "unknown",
    running: info.State?.Running === true,
    exit_code: Number.isSafeInteger(info.State?.ExitCode)
      ? info.State.ExitCode
      : null,
    oom_killed: info.State?.OOMKilled === true,
    restart_count: Number.isSafeInteger(info.RestartCount)
      ? info.RestartCount
      : null,
    engine_error_present: Boolean(info.State?.Error),
    engine_error_classifications: classifyPanelLogs(
      String(info.State?.Error ?? ""),
    ),
    image_matches_pin: info.Image === CRAFTY.amd64_config,
  };
}

// Application identity comes from cwd; harness identity comes from this module's
// checkout even when it is invoked from a separate exact-commit candidate tree.
export function acceptanceCommits() {
  const commit = execute("git", ["rev-parse", "HEAD"]);
  const harness_commit = execute("git", [
    "-C",
    dirname(fileURLToPath(import.meta.url)),
    "rev-parse",
    "HEAD",
  ]);
  assert.match(commit, /^[a-f0-9]{40}$/);
  assert.match(harness_commit, /^[a-f0-9]{40}$/);
  return { commit, harness_commit };
}

// No inherited child output: a failed panel, CLI or BDS command can contain
// credentials. The reviewable report uses fixed stage names and classifications.
function execute(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 8 * 1024 ** 2,
      stdio: ["pipe", "pipe", "pipe"],
      ...options,
    }).trim();
  } catch (error) {
    const failure = Error("subprocess failed; private output omitted");
    failure.code = "SUBPROCESS_FAILURE";
    failure.subprocess = {
      exit_code: Number.isSafeInteger(error.status) ? error.status : null,
      timed_out: error.code === "ETIMEDOUT",
      output_bound_exceeded: error.code === "ENOBUFS",
      signal: ["SIGTERM", "SIGKILL", "SIGABRT"].includes(error.signal)
        ? error.signal
        : null,
      stderr_classifications: classifyPanelLogs(String(error.stderr ?? "")),
    };
    throw failure;
  }
}

async function waitFor(callback, label, timeout = 120000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      return await callback();
    } catch (error) {
      last = error;
      /* retry without logging private values */
    }
    await sleep(1000);
  }
  const failure = Error(`timed out: ${label}`);
  failure.code = "WAIT_TIMEOUT";
  failure.last_code = failureCode(last);
  if (last?.subprocess) failure.last_subprocess = last.subprocess;
  throw failure;
}

// Download only the exact official origin/path. Redirects, HTML error pages,
// oversized downloads and a changed binary fail before Crafty imports anything.
export async function downloadBds(destination) {
  requireDisposable();
  const response = await fetch(BDS.url, {
    redirect: "error",
    signal: AbortSignal.timeout(180000),
    headers: { "User-Agent": "bedrock-surface-map-disposable-acceptance" },
  });
  assert.equal(response.status, 200, "official pinned BDS download failed");
  const parts = [];
  let size = 0;
  for await (const part of response.body) {
    size += part.length;
    assert.ok(size <= 512 * 1024 ** 2, "BDS download exceeds bound");
    parts.push(part);
  }
  const bytes = Buffer.concat(parts);
  assert.equal(
    bytes.readUInt32LE(0),
    0x04034b50,
    "official response is not a ZIP",
  );
  assert.equal(
    sha256(bytes),
    BDS.sha256,
    "official BDS ZIP differs from compatibility pin",
  );
  await writeFile(destination, bytes, { mode: 0o600, flag: "wx" });
  return { ...BDS, bytes: size, verified_sha256: sha256(bytes) };
}

function panelClient(port, certificate, recordFailure = () => {}) {
  const pin = new X509Certificate(certificate).fingerprint256;
  let token;
  const api = (path, method = "GET", body, anonymous = false) =>
    new Promise((ok, fail) => {
      assert.match(path, /^\/api\/v2\/[A-Za-z0-9_/?=&.-]+$/);
      const bytes = body === undefined ? undefined : JSON.stringify(body);
      const req = request(
        {
          hostname: "127.0.0.1",
          servername: "localhost",
          port,
          path,
          method,
          ca: certificate,
          rejectUnauthorized: true,
          checkServerIdentity: (_host, cert) =>
            cert.fingerprint256 === pin
              ? undefined
              : Error("disposable panel certificate changed"),
          timeout: 5000,
          headers: {
            "content-type": "application/json",
            ...(token && !anonymous
              ? { authorization: `Bearer ${token}` }
              : {}),
          },
        },
        (res) => {
          const parts = [];
          let size = 0;
          res.on("data", (part) => {
            size += part.length;
            if (size > 8 * 1024 ** 2)
              req.destroy(Error("panel response bound"));
            else parts.push(part);
          });
          res.on("error", (error) => {
            recordFailure({
              kind: "response-transport",
              code: failureCode(error),
            });
            fail(Error("panel response transport failed; details omitted"));
          });
          res.on("end", () => {
            try {
              const result = JSON.parse(Buffer.concat(parts));
              if (
                res.statusCode < 200 ||
                res.statusCode >= 300 ||
                result.status !== "ok"
              ) {
                recordFailure({
                  kind: "api-rejected",
                  http_status: res.statusCode,
                });
                throw Error(
                  `panel ${method} request failed (${res.statusCode}); details omitted`,
                );
              }
              ok(result.data);
            } catch (error) {
              if (error instanceof SyntaxError)
                recordFailure({
                  kind: "invalid-json",
                  http_status: res.statusCode,
                });
              fail(
                Error(
                  `panel ${method} response failed (${res.statusCode}); details omitted`,
                ),
              );
            }
          });
        },
      );
      req.on("error", (error) => {
        recordFailure({ kind: "request-transport", code: failureCode(error) });
        const failure = Error("disposable panel HTTPS request failed");
        failure.code = failureCode(error);
        fail(failure);
      });
      req.on("timeout", () => {
        recordFailure({ kind: "request-timeout", code: "ETIMEDOUT" });
        req.destroy();
      });
      req.end(bytes);
    });
  return {
    api,
    authenticate: async (credentials) => {
      const auth = await api("/api/v2/auth/login", "POST", credentials, true);
      assert.equal(typeof auth.token, "string");
      assert.ok(auth.token.length > 20);
      token = auth.token;
    },
  };
}

async function jsonRead(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(5000),
    redirect: "error",
  });
  assert.equal(response.status, 200);
  const bytes = await response.text();
  assert.ok(bytes.length < 1024 ** 2);
  return JSON.parse(bytes);
}

// Standalone runner; all Docker resources and private scratch belong to this
// invocation. The seed is explicitly synthetic; BDS creates a separate fresh
// official world. Only empty-server script/transport behavior is asserted.
export async function runCraftyAcceptance(
  candidateRoot,
  nativeRoot,
  fixtureRoot,
  output,
) {
  requireDisposable();
  assert.ok(process.getuid() > 0, "use the non-root hosted runner operator");
  const { commit, harness_commit } = acceptanceCommits();
  assert.equal(commit, process.env.CRAFTY_SOURCE_SHA);
  await mkdir(dirname(output), { recursive: true });
  try {
    await lstat(output);
    throw Error("evidence destination already exists");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temp = await mkdtemp(join(tmpdir(), "surface-crafty-"));
  await chmod(temp, 0o700);
  const project = `surface-crafty-${randomBytes(6).toString("hex")}`;
  const network = `${project}-ingest`,
    panel = `${project}-panel`,
    registry = `${project}-registry`;
  const deployment = join(temp, "deployment"),
    installed = join(temp, "package"),
    state = join(temp, "snapshot");
  const docker = (...args) => execute("docker", args);
  const compose = (...args) =>
    docker(
      "compose",
      "--project-directory",
      deployment,
      "-f",
      join(deployment, "compose.yaml"),
      ...args,
    );
  const report = {
    schema_version: 1,
    scope: "disposable-crafty-real-bds-empty-server",
    commit,
    harness_commit,
    packaging_run_id: process.env.CRAFTY_PACKAGING_RUN_ID,
    crafty: CRAFTY,
    bds: BDS,
    ok: false,
    stage: "initialize",
    checks: [],
    limitations: [
      "No game client or player connected",
      "No player movement, terrain scans, production worlds or public HTTPS tested",
      "Map services use a parsed synthetic seed; it does not represent the fresh BDS world's terrain",
      "Beta APIs enabled only in the newly generated disposable world",
      "Only this process trusts the disposable panel certificate",
    ],
  };
  let registryStarted = false,
    networkStarted = false,
    panelStarted = false,
    composeStarted = false,
    client,
    serverId,
    serverPath;
  const logLines = new Set();
  const capturePanelFailure = () => {
    try {
      const info = JSON.parse(
        execute("docker", ["inspect", panel], {
          timeout: 10000,
          maxBuffer: 1024 ** 2,
        }),
      )[0];
      report.panelState = sanitizePanelState(info);
      // Also remove a container left behind by an unsuccessful docker run.
      panelStarted = true;
    } catch {
      report.panelState = { exists: null, inspect_available: false };
    }
    try {
      // Docker may place either stream on stderr; collect both privately.
      const logs = spawnSync("docker", ["logs", "--tail", "300", panel], {
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 1024 ** 2,
        stdio: ["ignore", "pipe", "pipe"],
      });
      report.panel_logs = {
        capture_succeeded: logs.status === 0,
        output_bound_exceeded: logs.error?.code === "ENOBUFS",
        ...classifyPanelLogs(`${logs.stdout ?? ""}\n${logs.stderr ?? ""}`),
      };
    } catch {
      report.panel_logs = { capture_succeeded: false };
    }
  };
  const collectLogs = async () => {
    if (!client || !serverId) return;
    const lines = await client.api(`/api/v2/servers/${serverId}/logs`);
    assert.ok(
      Array.isArray(lines) && lines.every((v) => typeof v === "string"),
    );
    for (const line of lines) logLines.add(line);
    assert.ok(logLines.size < 20000, "BDS log line bound");
    report.bds_console = inspectBdsLogs([...logLines]);
  };
  const checkLogs = async () => {
    await collectLogs();
    assert.equal(
      report.bds_console.script_errors,
      0,
      "BDS console reports script errors",
    );
    assert.equal(
      report.bds_console.export_warnings,
      0,
      "BDS console reports export errors",
    );
    assert.equal(
      report.bds_console.player_connections,
      0,
      "unexpected player connection",
    );
  };
  const collectContentLogs = () => {
    const content = JSON.parse(
      docker(
        "exec",
        panel,
        "python3",
        "-c",
        "from pathlib import Path; import json,sys; files=[p for p in Path(sys.argv[1]).rglob('*') if p.is_file() and not p.is_symlink() and 'contentlog' in p.name.lower()]; assert len(files)<=32; assert sum(p.stat().st_size for p in files)<=1048576; print(json.dumps({'files':len(files),'lines':[line for p in files for line in p.read_text(errors='replace').splitlines()]}))",
        `${serverPath}/logs`,
      ),
    );
    assert.ok(Number.isSafeInteger(content.files) && content.files >= 0);
    report.content_log_files_inspected = content.files;
    const classified = inspectBdsLogs(content.lines);
    report.bds_content_logs = classified;
    assert.equal(
      classified.script_errors,
      0,
      "BDS content log reports script errors",
    );
    assert.equal(
      classified.export_warnings,
      0,
      "BDS content log reports export errors",
    );
  };
  const action = (name) =>
    client.api(`/api/v2/servers/${serverId}/action/${name}`, "POST");
  // Actual process inspection supplements Crafty's asynchronously sampled stats.
  const processCount = () =>
    Number(
      docker(
        "exec",
        panel,
        "python3",
        "-c",
        "import os; print(sum(open('/proc/'+p+'/comm').read().strip()=='bedrock_server' for p in os.listdir('/proc') if p.isdigit() and os.path.isfile('/proc/'+p+'/comm')))",
      ),
    );
  const stopped = () =>
    waitFor(async () => {
      assert.equal(processCount(), 0);
      assert.equal(
        (await client.api(`/api/v2/servers/${serverId}/stats`)).running,
        false,
      );
    }, "BDS stopped under Crafty");
  try {
    report.stage = "official-bds-download";
    report.bds = await downloadBds(join(temp, "official-bds.zip"));
    report.stage = "stage-exact-native-artifacts";
    const bases = JSON.parse(await readFile("deploy/images/bases.json"));
    const version = JSON.parse(await readFile("package.json")).version;
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
    await waitFor(
      async () =>
        assert.equal(
          (
            await fetch(`http://127.0.0.1:${registryPort}/v2/`, {
              signal: AbortSignal.timeout(2000),
            })
          ).status,
          200,
        ),
      "disposable registry",
    );
    const { candidate, release } = await stageLocalCandidate(
      candidateRoot,
      `127.0.0.1:${registryPort}`,
      version,
    );
    assert.equal(candidate.commit, commit);
    const archive = join(
      nativeRoot,
      `bedrock-surface-map-v${version}-linux-amd64.tar.gz`,
    );
    const nativeHash = sha256(await readFile(archive));
    assert.equal(
      nativeHash,
      candidate.images.runtime.platforms.amd64.release_sha256,
    );
    execute(process.execPath, ["scripts/release/audit.mjs", archive]);
    await mkdir(installed);
    execute("tar", ["-xzf", archive, "--strip-components=1", "-C", installed]);
    assert.equal(
      JSON.parse(await readFile(join(installed, "release-manifest.json")))
        .commit,
      commit,
    );
    await chmod(join(installed, "bedrock-map"), 0o755);
    await writeFile(
      join(installed, "deployment-release.json"),
      JSON.stringify(release),
      { mode: 0o600 },
    );
    const cli = (...args) => {
      const result = JSON.parse(
        execute(
          join(installed, "bedrock-map"),
          [
            "--json",
            "--resources",
            join(installed, "share/bedrock-surface-map"),
            "--state",
            state,
            ...args,
          ],
          { cwd: temp },
        ),
      );
      assert.equal(result.ok, true, "native CLI rejected acceptance input");
      return result;
    };
    cli("init");
    cli(
      "import",
      "--input",
      join(fixtureRoot, "generated.mcworld"),
      "--assets",
      join(fixtureRoot, "assets.zip"),
    );
    docker("network", "create", "--internal", network);
    networkStarted = true;
    const config = join(temp, "deployment.toml"),
      passwordFile = join(temp, "viewer-password");
    await writeFile(passwordFile, randomBytes(32).toString("hex"), {
      mode: 0o600,
    });
    await writeFile(
      config,
      `schema_version=1\nproject='${project}'\npublic_origin='https://map.example.test'\n[features]\nterrain=true\nplayers=true\n[bds]\nnetwork='${network}'\n[gateway]\nmode='proxy'\nport=18080\n`,
      { mode: 0o600 },
    );
    cli(
      "deploy",
      "init",
      "--dir",
      deployment,
      "--config",
      config,
      "--viewer-password-file",
      passwordFile,
    );
    cli(
      "deploy",
      "prepare",
      "--dir",
      deployment,
      "--snapshot-state",
      state,
      "--assets",
      join(fixtureRoot, "assets.zip"),
    );
    const marker = JSON.parse(
      await readFile(join(deployment, "prepared/preparation.json")),
    );
    composeStarted = true;
    compose("up", "-d", "players", "terrain");
    const containers = {};
    for (const name of ["players", "terrain"]) {
      containers[name] = JSON.parse(
        docker("inspect", compose("ps", "-aq", name)),
      )[0];
      assert.ok(
        !Object.values(containers[name].HostConfig.PortBindings ?? {}).some(
          (v) => v?.length,
        ),
        "collectors must not publish host ports",
      );
      await waitFor(
        async () =>
          assert.equal(
            JSON.parse(docker("inspect", containers[name].Id))[0].State.Health
              .Status,
            "healthy",
          ),
        `${name} native health`,
      );
    }
    const readAddress = (name, port) =>
      `http://${Object.entries(containers[name].NetworkSettings.Networks).find(([key]) => key !== network)[1].IPAddress}:${port}`;
    const playersBase = readAddress("players", 8110),
      terrainBase = readAddress("terrain", 8111);
    assert.equal((await jsonRead(`${playersBase}/healthz`)).accepted, 0);
    assert.equal((await jsonRead(`${terrainBase}/healthz`)).status, "starting");
    for (const [name, port, path, header] of [
      ["players", 8081, "snapshot", "x-tracker-token"],
      ["terrain", 8082, "terrain", "x-terrain-token"],
    ]) {
      const ip = containers[name].NetworkSettings.Networks[network].IPAddress;
      const response = await fetch(`http://${ip}:${port}/ingest/v1/${path}`, {
        method: "POST",
        headers: {
          [header]: "deliberately-invalid",
          "content-type": "application/json",
        },
        body: "{}",
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(
        response.status,
        401,
        "collector must reject a wrong credential",
      );
    }
    report.native = {
      archive_sha256: nativeHash,
      runtime: candidate.images.runtime.platforms.amd64.manifest_digest,
      seed: "parsed-synthetic-fixture",
      no_accepted_synthetic_writes: true,
      unauthenticated_ingest_rejected: true,
    };
    report.stage = "crafty-image-pull";
    docker("pull", "--platform", "linux/amd64", CRAFTY.image);
    report.stage = "crafty-image-identity";
    const image = JSON.parse(docker("image", "inspect", CRAFTY.image))[0];
    assert.equal(image.Architecture, "amd64");
    assert.equal(image.Id, CRAFTY.amd64_config);
    assert.equal(
      image.Config.Labels["org.opencontainers.image.revision"],
      CRAFTY.revision,
    );
    report.stage = "crafty-container-boot";
    docker(
      "run",
      "-d",
      "--name",
      panel,
      "--hostname",
      "crafty-acceptance",
      "--network",
      network,
      "--memory",
      "4g",
      "--cpus",
      "2",
      "--pids-limit",
      "768",
      "--log-opt",
      "max-size=5m",
      "--log-opt",
      "max-file=2",
      "-p",
      "127.0.0.1::8443",
      "-e",
      "TZ=UTC",
      CRAFTY.image,
    );
    panelStarted = true;
    const info = JSON.parse(docker("inspect", panel))[0];
    assert.equal(info.HostConfig.Privileged, false);
    assert.deepEqual(Object.keys(info.HostConfig.PortBindings), ["8443/tcp"]);
    assert.equal(
      info.HostConfig.PortBindings["8443/tcp"][0].HostIp,
      "127.0.0.1",
    );
    assert.equal(
      JSON.parse(docker("network", "inspect", network))[0].Internal,
      true,
    );
    report.stage = "crafty-certificate";
    const certificate = await waitFor(
      () =>
        docker(
          "exec",
          panel,
          "cat",
          "/crafty/app/config/web/certs/commander.cert.pem",
        ),
      "Crafty certificate",
    );
    client = panelClient(
      info.NetworkSettings.Ports["8443/tcp"][0].HostPort,
      certificate,
      (failure) => {
        report.panel_api_failure = { stage: report.stage, ...failure };
      },
    );
    report.stage = "crafty-credentials";
    const credentials = JSON.parse(
      await waitFor(
        () =>
          docker("exec", panel, "cat", "/crafty/app/config/default-creds.txt"),
        "Crafty fresh credentials",
      ),
    );
    report.stage = "crafty-authenticate";
    await waitFor(
      () =>
        client.authenticate({
          username: credentials.username,
          password: credentials.password,
        }),
      "Crafty authenticated API",
    );
    // Delete the bootstrap credential file as soon as the private in-memory
    // session exists. Neither password nor session token enters evidence.
    report.stage = "crafty-bootstrap-cleanup-and-import-staging";
    docker("exec", panel, "rm", "/crafty/app/config/default-creds.txt");
    credentials.password = undefined;
    docker("exec", panel, "mkdir", "-p", "/crafty/import/upload");
    docker(
      "cp",
      join(temp, "official-bds.zip"),
      `${panel}:/crafty/import/upload/official-bds.zip`,
    );
    docker(
      "exec",
      panel,
      "chown",
      "crafty:root",
      "/crafty/import/upload/official-bds.zip",
    );
    report.stage = "crafty-import-official-bds";
    serverId = (await client.api("/api/v2/servers", "POST", bedrockImport()))
      .new_server_uuid;
    assert.match(serverId, /^[a-f0-9-]{36}$/);
    const server = await waitFor(async () => {
      const value = await client.api(`/api/v2/servers/${serverId}`);
      assert.equal(
        (await client.api(`/api/v2/servers/${serverId}/stats`)).importing,
        false,
      );
      assert.match(value.path, /^\/crafty\/servers\/[a-f0-9-]{36}$/);
      docker("exec", panel, "test", "-x", `${value.path}/bedrock_server`);
      return value;
    }, "Crafty BDS import");
    serverPath = server.path;
    const world = "acceptance-fresh",
      projection = join(temp, "server-projection");
    await mkdir(join(projection, "worlds", world), { recursive: true });
    const properties = `server-name=Disposable acceptance\nlevel-name=${world}\nlevel-seed=12345\nlevel-type=FLAT\nserver-port=19132\nserver-portv6=19133\nonline-mode=true\nallow-list=true\nmax-players=1\nview-distance=4\ntick-distance=4\nallow-cheats=false\ncontent-log-file-enabled=true\ncontent-log-console-output-enabled=true\npause-when-empty-seconds=0\n`;
    await writeFile(join(projection, "server.properties"), properties);
    docker(
      "cp",
      join(projection, "server.properties"),
      `${panel}:${serverPath}/server.properties`,
    );
    docker(
      "exec",
      panel,
      "chown",
      "crafty:root",
      `${serverPath}/server.properties`,
    );
    report.stage = "fresh-world-generation";
    await action("start_server");
    await waitFor(async () => {
      await checkLogs();
      assert.ok(report.bds_console.starts >= 1);
      assert.equal(processCount(), 1);
    }, "fresh official world startup");
    await action("stop_server");
    await stopped();
    await checkLogs();
    docker(
      "exec",
      panel,
      "test",
      "-f",
      `${serverPath}/worlds/${world}/db/CURRENT`,
    );
    docker(
      "cp",
      `${panel}:${serverPath}/worlds/${world}/level.dat`,
      join(projection, "worlds", world, "level.dat"),
    );
    docker("cp", `${panel}:${serverPath}/config`, projection);
    const levelPath = join(projection, "worlds", world, "level.dat");
    const beta = enableDisposableBetaApis(await readFile(levelPath));
    await writeFile(levelPath, beta);
    report.stage = "native-export-install-and-check";
    const exportPath = join(temp, "bds-export.zip"),
      secretPath = join(temp, "private-export");
    cli(
      "deploy",
      "export-bds",
      "--dir",
      deployment,
      "--world",
      world,
      "--server-dir",
      projection,
      "--output",
      exportPath,
      "--secrets-dir",
      secretPath,
    );
    const install = join(temp, "install");
    await mkdir(install);
    execute("python3", ["-m", "zipfile", "-e", exportPath, install]);
    await cp(secretPath, install, { recursive: true });
    await cp(levelPath, join(install, "worlds", world, "level.dat"));
    docker("cp", `${install}/.`, `${panel}:${serverPath}/`);
    docker(
      "exec",
      panel,
      "chown",
      "-R",
      "crafty:root",
      `${serverPath}/behavior_packs`,
      `${serverPath}/config`,
      `${serverPath}/worlds/${world}`,
    );
    docker(
      "exec",
      panel,
      "python3",
      "-c",
      "import os,sys; [os.chmod(os.path.join(p,f),0o600) for p,ds,fs in os.walk(sys.argv[1]) for f in fs if f=='secrets.json']",
      `${serverPath}/config`,
    );
    // Re-read installed bytes through Docker, rather than checking the proposed
    // staging files. check-bds never reads the live world's LevelDB.
    const actual = join(temp, "installed-readback");
    await mkdir(actual);
    for (const name of ["server.properties", "config", "behavior_packs"])
      docker("cp", `${panel}:${serverPath}/${name}`, actual);
    await mkdir(join(actual, "worlds", world), { recursive: true });
    for (const name of ["world_behavior_packs.json", "level.dat"])
      docker(
        "cp",
        `${panel}:${serverPath}/worlds/${world}/${name}`,
        join(actual, "worlds", world, name),
      );
    assert.deepEqual(
      await readFile(join(actual, "worlds", world, "level.dat")),
      beta,
    );
    cli(
      "deploy",
      "check-bds",
      "--dir",
      deployment,
      "--world",
      world,
      "--server-dir",
      actual,
    );
    report.checks.push(
      "official-world-created-under-crafty",
      "exported-compiled-packs-config-and-private-secrets-installed",
      "native-check-bds-installed-readback-pass",
    );
    const observe = async (previous, changedInstance) =>
      waitFor(async () => {
        await checkLogs();
        const players = await jsonRead(
          `${playersBase}/api/v1/worlds/${marker.world_id}/players`,
        );
        const terrain = await jsonRead(`${terrainBase}/healthz`);
        assert.equal(terrain.generation, marker.generation);
        const snapshot = assertEmptyLive(players, terrain, previous);
        if (changedInstance)
          assert.notEqual(snapshot.instance_id, changedInstance);
        const terrainTime = Date.now() - terrain.sample_age_ms;
        if (previous)
          assert.ok(
            terrainTime > previous.terrain_sample_ms + 1000,
            "require another terrain heartbeat",
          );
        return { ...snapshot, terrain_sample_ms: terrainTime };
      }, "recurring authenticated BDS heartbeats");
    report.stage = "bds-packs-first-start";
    await action("start_server");
    const first = await observe();
    const recurring = await observe(first);
    report.stage = "crafty-bds-restart";
    await action("restart_server");
    const restarted = await observe(undefined, first.instance_id);
    const after = await observe(restarted);
    assert.equal(processCount(), 1);
    await waitFor(
      async () =>
        assert.equal(
          (await client.api(`/api/v2/servers/${serverId}/stats`)).running,
          true,
        ),
      "Crafty running stats after restart",
    );
    const health = await jsonRead(`${playersBase}/healthz`);
    assert.ok(health.accepted >= 4);
    report.heartbeats = {
      empty_roster: true,
      first_sequence: first.sequence,
      recurring_sequence: recurring.sequence,
      restart_changed_instance: first.instance_id !== restarted.instance_id,
      restart_sequence: restarted.sequence,
      recurring_restart_sequence: after.sequence,
      player_accepted: health.accepted,
      terrain_live_before_and_after_restart: true,
      terrain_active_chunks: 0,
    };
    await checkLogs();
    assert.equal(
      report.bds_console.expected_version_seen,
      true,
      "BDS did not report pinned version",
    );
    assert.ok(
      report.bds_console.starts >= 3,
      "require fresh start, pack start and panel restart",
    );
    report.checks.push(
      "authenticated-empty-roster-recurs",
      "terrain-empty-health-recurs",
      "panel-restart-new-producer-observed",
      "no-script-errors-or-player-connections",
    );
    report.ok = true;
    report.stage = "complete";
  } catch (error) {
    // Preserve the meaningful failing stage, never an exception containing an
    // assertion's actual secret, panel response, raw log, or subprocess stderr.
    report.ok = false;
    report.failure = {
      code: failureCode(error),
      ...(failureCodes.has(error.last_code)
        ? { last_code: error.last_code }
        : {}),
      ...(error.subprocess ? { subprocess: error.subprocess } : {}),
      ...(error.last_subprocess
        ? { last_subprocess: error.last_subprocess }
        : {}),
    };
    capturePanelFailure();
  } finally {
    const cleanup = [];
    if (panelStarted) {
      if (client && serverId) {
        try {
          await action("stop_server");
          await stopped();
          collectContentLogs();
          await checkLogs();
        } catch {
          if (report.ok) {
            report.ok = false;
            report.stage = "final-stop-and-log-inspection";
            capturePanelFailure();
          }
        }
      }
      try {
        docker("rm", "-f", "-v", panel);
      } catch {
        cleanup.push("panel-removal");
      }
    }
    if (composeStarted) {
      try {
        compose("down", "--volumes", "--remove-orphans", "--timeout", "10");
      } catch {
        cleanup.push("map-stack-removal");
      }
    }
    if (networkStarted) {
      try {
        docker("network", "rm", network);
      } catch {
        cleanup.push("private-network-removal");
      }
    }
    if (registryStarted) {
      try {
        docker("rm", "-f", "-v", registry);
      } catch {
        cleanup.push("registry-removal");
      }
    }
    try {
      await rm(temp, { recursive: true, force: true });
    } catch {
      cleanup.push("private-scratch-removal");
    }
    report.cleanup = { ok: cleanup.length === 0, failures: cleanup };
    if (cleanup.length) report.ok = false;
    await writeFile(output, JSON.stringify(report, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
  }
  if (!report.ok)
    throw Error(
      `Crafty/BDS acceptance failed at ${report.stage}; see sanitized evidence`,
    );
  console.log(
    "Crafty/BDS empty-server acceptance passed; sanitized evidence written.",
  );
  return report;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const args = process.argv.slice(2);
  assert.equal(
    args.length,
    4,
    "usage: crafty-run.mjs <combined-oci> <native-dist> <parser-fixture> <new-evidence.json>",
  );
  await runCraftyAcceptance(...args.map((v) => resolve(v)));
}
