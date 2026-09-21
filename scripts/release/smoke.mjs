import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const archive = process.argv[2];
if (!archive) throw Error("usage: smoke.mjs <archive>");
const worldIndex = process.argv.indexOf("--world");
const assetsIndex = process.argv.indexOf("--assets");
const world = worldIndex < 0 ? null : process.argv[worldIndex + 1];
const assets = assetsIndex < 0 ? null : process.argv[assetsIndex + 1];
if (Boolean(world) !== Boolean(assets))
  throw Error("smoke requires both --world and --assets");
const staging = await mkdtemp(join(tmpdir(), "bedrock-map-smoke-"));
let child;
try {
  execFileSync("tar", ["-xzf", archive, "-C", staging], { stdio: "inherit" });
  const root = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
    .split("\n")
    .find((entry) => entry.endsWith("/bedrock-map"))
    ?.replace(/bedrock-map$/, "");
  if (!root) throw Error("bedrock-map binary missing");
  const install = join(staging, root);
  const binary = join(install, "bedrock-map");
  const version = execFileSync(binary, ["--version"], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin" },
  });
  if (!version.includes("bedrock-map") || version.includes("(source)")) {
    throw Error("packaged executable lacks release commit metadata");
  }
  const state = join(staging, "state with spaces é");
  const invoke = (...args) =>
    execFileSync(binary, args, {
      cwd: tmpdir(),
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin" },
    });
  JSON.parse(invoke("init", "--state", state, "--json"));
  JSON.parse(
    invoke(
      "demo",
      "--state",
      state,
      "--resources",
      join(install, "share/bedrock-surface-map"),
      "--json",
    ),
  );
  const status = JSON.parse(invoke("status", "--state", state, "--json"));
  if (!status.active?.dataset_id)
    throw Error("documented status command did not report the demo dataset");
  const doctor = JSON.parse(invoke("doctor", "--state", state, "--json"));
  const resourceCheck = doctor.checks?.find(
    (check) => check.id === "resources",
  );
  if (resourceCheck?.status !== "pass")
    throw Error("packaged doctor did not discover its bundled resources");
  const releasePath = join(install, "release-manifest.json");
  const releaseBytes = await readFile(releasePath);
  const mismatched = JSON.parse(releaseBytes);
  mismatched.commit = "0".repeat(40);
  await writeFile(releasePath, JSON.stringify(mismatched));
  try {
    const rejected = spawnSync(binary, ["doctor", "--state", state, "--json"], {
      cwd: tmpdir(),
      env: { PATH: "/usr/bin:/bin" },
      encoding: "utf8",
      timeout: 5000,
    });
    const check = JSON.parse(rejected.stdout).checks.find(
      (item) => item.id === "resources",
    );
    if (rejected.status !== 3 || check?.status !== "fail")
      throw Error("packaged doctor accepted a mixed release commit");
  } finally {
    await writeFile(releasePath, releaseBytes);
  }
  let imported = null;
  if (world) {
    const response = JSON.parse(
      invoke(
        "import",
        "--state",
        state,
        "--input",
        world,
        "--assets",
        assets,
        "--replace-active",
        "--json",
      ),
    );
    if (
      !response.ok ||
      response.report?.regions !== 1 ||
      response.report?.surface_columns !== 256
    )
      throw Error("packaged binary failed the generated-world parser import");
    const expectedSource = createHash("sha256")
      .update(await readFile(world))
      .digest("hex");
    if (response.report.source_sha256 !== expectedSource)
      throw Error("generated-world source fingerprint mismatch");
    const selected = JSON.parse(invoke("status", "--state", state, "--json"));
    if (selected.active?.dataset_id !== response.dataset)
      throw Error("generated-world import was not selected");
    const checked = JSON.parse(invoke("doctor", "--state", state, "--json"));
    if (!checked.ok) throw Error("generated-world import failed doctor");
    imported = { dataset_id: response.dataset, source_sha256: expectedSource };
  }
  child = spawn(
    binary,
    [
      "serve",
      "--state",
      state,
      "--resources",
      join(install, "share/bedrock-surface-map"),
      "--json",
      "--bind",
      "127.0.0.1:0",
    ],
    {
      cwd: tmpdir(),
      env: { PATH: "/usr/bin:/bin" },
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
    fetch(url, { signal: AbortSignal.timeout(5000) }),
    fetch(new URL("viewer-config.json", url), {
      signal: AbortSignal.timeout(5000),
    }),
    fetch(new URL("api/v1/health/ready", url), {
      signal: AbortSignal.timeout(5000),
    }),
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
  child = null;
  if (imported) {
    const selected = JSON.parse(invoke("status", "--state", state, "--json"));
    const manifest = JSON.parse(
      await readFile(
        join(
          state,
          "datasets",
          selected.active.dataset_id,
          "public/manifest.json",
        ),
        "utf8",
      ),
    );
    const region = join(
      state,
      "datasets",
      selected.active.dataset_id,
      "public",
      manifest.regions[0].url,
    );
    await writeFile(region, "tampered");
    const failed = spawnSync(binary, ["doctor", "--state", state, "--json"], {
      cwd: tmpdir(),
      env: { PATH: "/usr/bin:/bin" },
      encoding: "utf8",
      timeout: 5000,
    });
    if (failed.status !== 3 || JSON.parse(failed.stdout).ok !== false)
      throw Error("corrupted packaged region was not refused");
  }
  console.log(
    JSON.stringify({
      ok: true,
      archive,
      host: `${process.platform}-${process.arch}`,
      version: version.trim(),
      generated_world_import: imported,
      corruption_refused: Boolean(imported),
      readiness_url: url,
    }),
  );
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  await rm(staging, { recursive: true, force: true });
}
