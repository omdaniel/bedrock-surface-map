import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";

const archive = process.argv[2];
if (!archive) throw Error("usage: browser-smoke.mjs <archive>");
const externalIndex = process.argv.indexOf("--external-url");
const externalUrl = externalIndex < 0 ? null : process.argv[externalIndex + 1];
if (externalIndex >= 0 && !externalUrl)
  throw Error("--external-url requires a URL");
if (externalUrl) {
  const target = new URL(externalUrl);
  if (
    target.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(target.hostname) ||
    !["/", "/map/"].includes(target.pathname)
  )
    throw Error("external browser smoke requires a loopback root or /map/ URL");
}
const mountPaths = externalUrl
  ? [new URL(externalUrl).pathname]
  : ["/", "/map/"];
const { chromium } = await import("playwright");
const staging = await mkdtemp(join(tmpdir(), "bedrock-map-browser-smoke-"));
const children = new Set();

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
  children.add(child);
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
    for (const basePath of mountPaths) {
      const { child, url } = externalUrl
        ? { child: null, url: externalUrl }
        : await start(
            binary,
            resources,
            join(staging, `state-${basePath === "/" ? "root" : "subpath"}`),
            basePath,
          );
      if (externalUrl) {
        const web = join(resources, "web");
        const html = Buffer.from(
          await (
            await fetch(url, { signal: AbortSignal.timeout(5000) })
          ).arrayBuffer(),
        );
        if (!html.equals(await readFile(join(web, "index.html"))))
          throw Error(
            "remote server is not serving the exact packaged frontend",
          );
        const wasm = (await readdir(join(web, "assets"))).find((file) =>
          file.endsWith(".wasm"),
        );
        if (!wasm) throw Error("packaged WASM asset is missing");
        const servedWasm = Buffer.from(
          await (
            await fetch(new URL(`assets/${wasm}`, url), {
              signal: AbortSignal.timeout(5000),
            })
          ).arrayBuffer(),
        );
        if (!servedWasm.equals(await readFile(join(web, "assets", wasm))))
          throw Error("remote server is not serving the exact packaged WASM");
      }
      const page = await browser.newPage({
        viewport: { width: 1280, height: 900 },
      });
      const failures = [];
      const errors = [];
      const loaded = [];
      page.on("requestfailed", (request) => failures.push(request.url()));
      page.on("pageerror", (error) => errors.push(String(error)));
      page.on("response", (response) =>
        loaded.push({ url: response.url(), status: response.status() }),
      );
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
        await page.mouse.move(640, 400);
        await page
          .locator("#inspect")
          .waitFor({ state: "visible", timeout: 5000 });
        const coordinates = await page.locator("#coordinates").textContent();
        if (!coordinates?.includes("-"))
          throw Error("synthetic terrain picking failed");
        const expected = [
          "viewer-config.json",
          "manifest.json",
          ".wasm",
          ".zst",
          ".png",
          ".js",
        ];
        for (const suffix of expected)
          if (
            !loaded.some(
              (item) => item.url.includes(suffix) && item.status === 200,
            )
          )
            throw Error(`packaged browser did not load ${suffix}`);
        if (
          loaded.some(
            (item) => !item.url.startsWith(new URL(url).origin + basePath),
          )
        )
          throw Error("packaged browser requested an out-of-prefix resource");
        if (errors.length || failures.length)
          throw Error(
            `browser failures: ${[...errors, ...failures].join("; ")}`,
          );
      } finally {
        await page.close();
        if (child) {
          child.kill("SIGTERM");
          await new Promise((resolve) => child.once("exit", resolve));
          children.delete(child);
        }
      }
    }
  } finally {
    await browser.close();
  }
  console.log(
    JSON.stringify({
      ok: true,
      archive,
      browser_rendered: true,
      mount_paths: mountPaths,
      browser_host: `${process.platform}-${process.arch}`,
      terrain_pixels: true,
      picking: true,
    }),
  );
} finally {
  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  await rm(staging, { recursive: true, force: true });
}
