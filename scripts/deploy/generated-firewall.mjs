import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

// Explicitly confined to disposable GitHub-hosted acceptance runners. Never
// called by the operator CLI or the ordinary local packaging smoke test.
export function firewallVantages({ docker, image, project }) {
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.RUNNER_ENVIRONMENT !== "github-hosted"
  )
    throw Error(
      "packet-level firewall acceptance requires a disposable GitHub-hosted runner",
    );
  const network = `${project}-clients`,
    clients = [],
    sudo = (...args) =>
      execFileSync("sudo", ["--non-interactive", ...args], {
        encoding: "utf8",
        timeout: 15_000,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
  docker("network", "create", network);
  let appliedScript;
  const cleanup = () => {
    try {
      if (appliedScript) sudo("sh", appliedScript, "remove");
    } finally {
      for (const client of clients) docker("rm", "-f", client.name);
      docker("network", "rm", network);
    }
  };
  try {
    for (const role of ["allowed", "denied"]) {
      const name = `${project}-${role}`;
      docker(
        "run",
        "-d",
        "--name",
        name,
        "--network",
        network,
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--entrypoint",
        "/bin/sleep",
        image,
        "600",
      );
      clients.push({ name });
      const info = JSON.parse(docker("inspect", name))[0];
      clients.at(-1).pid = info.State.Pid;
      clients.at(-1).address = info.NetworkSettings.Networks[network].IPAddress;
    }
  } catch (error) {
    cleanup();
    throw error;
  }
  const request = (client, host, port) => {
    try {
      return {
        code: sudo(
          "nsenter",
          "--target",
          String(client.pid),
          "--net",
          "/usr/bin/curl",
          "--noproxy",
          "*",
          "--max-time",
          "2",
          "--silent",
          "--request",
          "POST",
          "--output",
          "/dev/null",
          "--write-out",
          "%{http_code}",
          `http://${host}:${port}/ingest/v1/${port === 18082 ? "terrain" : "snapshot"}`,
        ),
        timeout: false,
      };
    } catch (error) {
      if (error.status !== 28) throw error;
      return { code: String(error.stdout).trim(), timeout: true };
    }
  };
  return {
    source: clients[0].address,
    cleanup,
    verify(deployment, host, ports) {
      // Establish both routes first, so an existing bridge/routing failure is
      // not misreported as successful filtering by the generated policy.
      for (const port of ports)
        for (const client of clients)
          assert.deepEqual(request(client, host, port), {
            code: "401",
            timeout: false,
          });
      appliedScript = join(deployment, "firewall-review.sh");
      sudo("sh", appliedScript, "apply");
      sudo("sh", appliedScript, "check");
      const first = sudo("iptables", "-w", "5", "-S", "DOCKER-USER");
      sudo("sh", appliedScript, "apply");
      assert.equal(sudo("iptables", "-w", "5", "-S", "DOCKER-USER"), first);
      for (const port of ports) {
        assert.deepEqual(request(clients[0], host, port), {
          code: "401",
          timeout: false,
        });
        assert.deepEqual(request(clients[1], host, port), {
          code: "000",
          timeout: true,
        });
      }
      const counters = sudo(
        "iptables",
        "-w",
        "5",
        "-L",
        "DOCKER-USER",
        "-v",
        "-n",
        "-x",
      )
        .split("\n")
        .filter((line) => line.includes(`bedrock-map:${project}`));
      assert.equal(counters.length, ports.length);
      assert.ok(
        counters.every((line) => Number(line.trim().split(/\s+/)[0]) > 0),
        "every scoped drop rule must match real packets",
      );
      sudo("sh", appliedScript, "remove");
      sudo("sh", appliedScript, "remove");
      assert.ok(
        !sudo("iptables", "-w", "5", "-S", "DOCKER-USER").includes(
          `bedrock-map:${project}`,
        ),
      );
      for (const port of ports)
        assert.deepEqual(request(clients[1], host, port), {
          code: "401",
          timeout: false,
        });
      return {
        backend: "Docker iptables / DOCKER-USER",
        authorized_source: true,
        unauthorized_source_blocked: true,
        return_traffic: true,
        idempotent_apply_remove: true,
        matched_drop_rules: counters.length,
        scope:
          "disposable native CI host and Docker client namespaces; not public-internet or actual BDS evidence",
      };
    },
  };
}
