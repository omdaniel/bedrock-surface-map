import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";

const archive = process.argv[2];
if (!archive) throw Error("usage: browser-smoke.mjs <archive>");
const { chromium } = await import("playwright");
const staging = await mkdtemp(join(tmpdir(), "bedrock-map-browser-smoke-"));

function packagedRoot() {
  return execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
    .split("\n")
    .find((entry) => entry.endsWith("/bedrock-map"))
    ?.replace(/bedrock-map$/, "");
}

async function start(binary, resources, state, basePath) {
  execFileSync(binary, ["init", "--state", state, "--json"], {
    cwd: tmpdir(),
    env: { PATH: "/usr/bin:/bin", HOME: staging },
  });
  execFileSync(
    binary,
    ["demo", "--state", state, "--resources", resources, "--json"],
    { cwd: tmpdir(), env: { PATH: "/usr/bin:/bin", HOME: staging } },
  );
  if (basePath !== "/") {
    const config = join(state, "config.toml");
    await writeFile(
      config,
      (await readFile(config, "utf8")).replace(
        'base_path = "/"',
        `base_path = "${basePath}"`,
      ),
    );
  }
  const child = spawn(
    binary,
    [
      "serve",
      "--state",
      state,
      "--resources",
      resources,
      "--json",
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
    child.stderr.once("data", (chunk) => reject(Error(String(chunk))));
  });
  return { child, url };
}

function assertTerrainPixels(bytes) {
  const image = PNG.sync.read(bytes);
  const colors = new Set();
  for (let index = 0; index < image.data.length; index += 4 * 127) {
    colors.add(
      `${image.data[index]},${image.data[index + 1]},${image.data[index + 2]},${image.data[index + 3]}`,
    );
  }
  if (colors.size < 8)
    throw Error("canvas screenshot lacks the expected terrain color variation");
}

try {
  execFileSync("tar", ["-xzf", archive, "-C", staging], { stdio: "inherit" });
  const root = packagedRoot();
  if (!root) throw Error("bedrock-map binary missing");
  const install = join(staging, root);
  const binary = join(install, "bedrock-map");
  const resources = join(install, "share/bedrock-surface-map");
  const browser = await chromium.launch({
    headless: true,
    args: ["--use-angle=swiftshader", "--enable-unsafe-webgpu"],
  });
  try {
    for (const basePath of ["/", "/map/"]) {
      const { child, url } = await start(
        binary,
        resources,
        join(staging, `state-${basePath === "/" ? "root" : "subpath"}`),
        basePath,
      );
      const page = await browser.newPage({
        viewport: { width: 1280, height: 900 },
      });
      const failures = [];
      const errors = [];
      page.on("requestfailed", (request) => failures.push(request.url()));
      page.on("pageerror", (error) => errors.push(String(error)));
      try {
        await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
        await page.waitForFunction(
          () =>
            window.__map?.ready &&
            window.__map.state().cached > 0 &&
            window.__map.state().pending === 0 &&
            window.__map.state().draws > 0,
          undefined,
          { timeout: 30000 },
        );
        const state = await page.evaluate(() => window.__map.state());
        if (state.cached < 1 || state.draws < 1)
          throw Error("fixture terrain was not rendered");
        assertTerrainPixels(await page.locator("#map").screenshot());
        if (errors.length || failures.length)
          throw Error(
            `browser failures: ${[...errors, ...failures].join("; ")}`,
          );
      } finally {
        await page.close();
        child.kill("SIGTERM");
        await new Promise((resolve) => child.once("exit", resolve));
      }
    }
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify({ ok: true, archive, browser_rendered: true }));
} finally {
  await rm(staging, { recursive: true, force: true });
}
