import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const archive = process.argv[2];
if (!archive) throw Error("usage: smoke.mjs <archive>");
const staging = await mkdtemp(join(tmpdir(), "bedrock-map-smoke-"));
try {
  execFileSync("tar", ["-xzf", archive, "-C", staging], { stdio: "inherit" });
  const root = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
    .split("\n")
    .find((entry) => entry.endsWith("/bedrock-map"))
    ?.replace(/bedrock-map$/, "");
  if (!root) throw Error("bedrock-map binary missing");
  const install = join(staging, root);
  const binary = join(install, "bedrock-map");
  const state = join(staging, "state with spaces");
  const invoke = (...args) =>
    execFileSync(binary, ["--state", state, ...args], {
      cwd: tmpdir(),
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", HOME: staging },
    });
  JSON.parse(invoke("--json", "init"));
  JSON.parse(
    invoke(
      "--resources",
      join(install, "share/bedrock-surface-map"),
      "--json",
      "demo",
    ),
  );
  const child = spawn(
    binary,
    [
      "--state",
      state,
      "--resources",
      join(install, "share/bedrock-surface-map"),
      "--json",
      "serve",
      "--bind",
      "127.0.0.1:0",
    ],
    {
      cwd: tmpdir(),
      env: { PATH: "/usr/bin:/bin", HOME: staging },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const url = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () => reject(Error("server did not become ready")),
      10000,
    );
    child.stdout.on("data", (chunk) => {
      output += chunk;
      for (const line of output.split("\n")) {
        try {
          const event = JSON.parse(line);
          if (event.event === "ready") {
            clearTimeout(timer);
            resolve(event.url);
          }
        } catch {}
      }
    });
    child.once("error", reject);
  });
  const [html, config, health] = await Promise.all([
    fetch(url),
    fetch(new URL("viewer-config.json", url)),
    fetch(new URL("api/v1/health/ready", url)),
  ]);
  if (
    !html.ok ||
    !config.ok ||
    !health.ok ||
    !(await html.text()).includes("Bedrock Surface Map")
  )
    throw Error("extracted server response verification failed");
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
  console.log(JSON.stringify({ ok: true, archive, url }));
} finally {
  await rm(staging, { recursive: true, force: true });
}
