import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generatedProducer } from "./generated-producer.mjs";
import { verifyGeneratedBrowser } from "./generated-browser.mjs";

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// This fixture uses a separate HTTPS reverse proxy and a BDS-network producer.
// No game binary, world database or public certificate is involved.
export async function verifyExistingServerTopology({
  temp,
  project,
  cli,
  state,
  assets,
  image,
  password,
  passwordFile,
  docker,
  waitFor,
  evidenceDirectory,
}) {
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.RUNNER_ENVIRONMENT !== "github-hosted"
  )
    throw Error(
      "Docker namespace acceptance requires a disposable GitHub-hosted runner",
    );
  const network = `${project}-ingest`,
    root = join(temp, "existing-server");
  const name = `${project}-existing`,
    producerName = `${name}-producer`,
    proxyName = `${name}-proxy`;
  const httpPort = await availablePort();
  let httpsPort = await availablePort();
  while (httpsPort === httpPort) httpsPort = await availablePort();
  let networkStarted = false,
    stackStarted = false,
    producerStarted = false,
    proxyStarted = false;
  const run = (...args) =>
    docker(
      "compose",
      "--project-directory",
      root,
      "-f",
      join(root, "compose.yaml"),
      ...args,
    );
  try {
    docker("network", "create", "--internal", network);
    networkStarted = true;
    const config = join(temp, "existing-server.toml");
    await writeFile(
      config,
      `schema_version=1\nproject='${name}'\npublic_origin='https://map.example.test'\n[features]\nterrain=true\nplayers=true\n[bds]\nnetwork='${network}'\n[gateway]\nmode='proxy'\nport=${httpPort}\n`,
      { mode: 0o600 },
    );
    assert.equal(
      cli(
        "deploy",
        "init",
        "--dir",
        root,
        "--config",
        config,
        "--viewer-password-file",
        passwordFile,
      ).ok,
      true,
    );
    assert.equal(
      cli(
        "deploy",
        "prepare",
        "--dir",
        root,
        "--snapshot-state",
        state,
        "--assets",
        assets,
      ).ok,
      true,
    );
    assert.equal(cli("deploy", "check", "--dir", root).ok, true);
    const generated = JSON.parse(await readFile(join(root, "compose.yaml")));
    for (const service of ["players", "terrain"])
      assert.equal(
        generated.services[service].ports,
        undefined,
        "ingestion must not publish host ports",
      );
    assert.deepEqual(generated.services.gateway.networks, ["app"]);
    stackStarted = true;
    run("up", "-d");
    const inspect = (service) =>
      JSON.parse(docker("inspect", run("ps", "-aq", service)))[0];
    for (const service of ["players", "terrain"])
      await waitFor(async () =>
        assert.equal(inspect(service).State.Health.Status, "healthy"),
      );
    for (const service of ["players", "terrain"])
      assert.ok(
        Object.values(inspect(service).HostConfig.PortBindings ?? {}).every(
          (bindings) => !bindings?.length,
        ),
      );
    assert.deepEqual(inspect("gateway").HostConfig.PortBindings["8080/tcp"], [
      { HostIp: "127.0.0.1", HostPort: String(httpPort) },
    ]);

    docker(
      "run",
      "-d",
      "--name",
      producerName,
      "--network",
      network,
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--entrypoint",
      "/bin/sleep",
      image,
      "1800",
    );
    producerStarted = true;
    const producerPid = JSON.parse(docker("inspect", producerName))[0].State
      .Pid;
    const hosts = {},
      addresses = {},
      tokens = {};
    for (const service of ["players", "terrain"]) {
      hosts[service] = `${name}-${service}-ingest`;
      const endpoint = inspect(service).NetworkSettings.Networks[network];
      assert.ok(endpoint.Aliases.includes(hosts[service]));
      addresses[hosts[service]] = endpoint.IPAddress;
      await waitFor(() =>
        assert.ok(
          docker(
            "exec",
            producerName,
            "/bin/busybox",
            "nslookup",
            "-type=A",
            `${hosts[service]}.`,
            "127.0.0.11",
          ).includes(addresses[hosts[service]]),
          "BDS namespace must resolve the generated collector alias",
        ),
      );
      tokens[service] = await readFile(
        join(root, `secrets/${service}.token`),
        "utf8",
      );
    }
    const transport = async (url, options) => {
      const target = new URL(url);
      const configuration = [
        `url = ${JSON.stringify(url)}`,
        `request = ${JSON.stringify(options.method)}`,
        ...Object.entries(options.headers).map(
          ([key, value]) => `header = ${JSON.stringify(`${key}: ${value}`)}`,
        ),
        `data-binary = ${JSON.stringify(options.body)}`,
      ].join("\n");
      // curl executes in the producer's network namespace. Secrets and JSON
      // enter through stdin, never process arguments or mounted world files.
      const result = execFileSync(
        "sudo",
        [
          "--non-interactive",
          "nsenter",
          "--target",
          String(producerPid),
          "--net",
          "/usr/bin/curl",
          "--noproxy",
          "*",
          "--silent",
          "--show-error",
          "--max-time",
          "5",
          "--resolve",
          `${target.hostname}:${target.port}:${addresses[target.hostname]}`,
          "--config",
          "-",
          "--write-out",
          "\n%{http_code}",
        ],
        {
          input: configuration,
          encoding: "utf8",
          timeout: 10_000,
          maxBuffer: 1024 ** 2,
        },
      );
      const split = result.lastIndexOf("\n"),
        status = Number(result.slice(split + 1));
      return new Response(status === 204 ? null : result.slice(0, split), {
        status,
      });
    };
    const marker = JSON.parse(
      await readFile(join(root, "prepared/preparation.json")),
    );
    const producer = generatedProducer({
      hosts,
      ports: { players: 8081, terrain: 8082 },
      tokens,
      world: marker.world_id,
      generation: marker.generation,
      transport,
    });
    await producer.negativeChecks();

    const proxy = join(temp, "external-proxy");
    await mkdir(proxy, { mode: 0o700 });
    const data = join(proxy, "data");
    await mkdir(data, { mode: 0o700 });
    await writeFile(
      join(proxy, "Caddyfile"),
      `{\n admin off\n skip_install_trust\n auto_https disable_redirects\n storage file_system {\n  root /data\n }\n}\nhttps://map.example.test:${httpsPort} {\n bind 127.0.0.1\n tls internal\n reverse_proxy 127.0.0.1:${httpPort} {\n  header_up Host map.example.test\n }\n}\n`,
      { mode: 0o600 },
    );
    docker(
      "run",
      "-d",
      "--name",
      proxyName,
      "--network",
      "host",
      "--user",
      `${process.getuid()}:${process.getgid()}`,
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--memory",
      "128m",
      "-v",
      `${join(proxy, "Caddyfile")}:/etc/caddy/Caddyfile:ro`,
      "-v",
      `${data}:/data`,
      image,
      "caddy",
      "run",
      "--config",
      "/etc/caddy/Caddyfile",
      "--adapter",
      "caddyfile",
    );
    proxyStarted = true;
    const ca = await waitFor(() =>
      readFile(join(data, "pki/authorities/local/root.crt")),
    );
    const browser = await verifyGeneratedBrowser({
      port: httpsPort,
      ca,
      password,
      producer,
      evidenceDirectory,
    });
    const logs = run("logs", "--no-color");
    assert.ok(
      [...Object.values(tokens), password].every(
        (secret) => !logs.includes(secret),
      ),
    );
    return {
      ok: true,
      scope: "synthetic-existing-bds-network-and-https-proxy",
      no_host_ingest: true,
      internal_network: true,
      collector_dns: true,
      secret_redaction: true,
      unchanged_generated_compose: true,
      proxy_loopback_bind: true,
      authenticated_delivery: true,
      browser,
    };
  } finally {
    if (proxyStarted) docker("rm", "-f", proxyName);
    if (producerStarted) docker("rm", "-f", producerName);
    if (stackStarted) run("down", "--remove-orphans", "-t", "5");
    if (networkStarted) docker("network", "rm", network);
  }
}
