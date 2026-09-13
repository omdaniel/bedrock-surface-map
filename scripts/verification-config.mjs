import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

export function viewerUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw Error(
      "Set a valid viewer URL using --url, MAP_URL or verification config",
    );
  }
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    (isIP(url.hostname) === 4 && url.hostname.startsWith("127."));
  if (
    url.username ||
    url.password ||
    !["http:", "https:"].includes(url.protocol) ||
    (url.protocol === "http:" && !loopback)
  )
    throw Error(
      "Viewer URL requires HTTPS, or HTTP on loopback, without credentials",
    );
  return url.href;
}

export function verificationConfig({
  argv = process.argv.slice(2),
  env = process.env,
  output = ".local/verification",
  options = {},
} = {}) {
  const defaults = Object.fromEntries(
    Object.entries(options)
      .filter(([, spec]) => spec.default !== undefined)
      .map(([key, spec]) => [key, spec.default]),
  );
  const definitions = Object.fromEntries(
    Object.entries(options).map(([key, { default: _, ...spec }]) => [
      key,
      spec,
    ]),
  );
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: "string" },
      url: { type: "string" },
      output: { type: "string" },
      webdriver: { type: "string" },
      "expected-regions": { type: "string" },
      ...definitions,
    },
  });
  const file = values.config ?? env.MAP_VERIFY_CONFIG;
  const saved = file ? JSON.parse(readFileSync(file, "utf8")) : {};
  if (!saved || typeof saved !== "object" || Array.isArray(saved))
    throw Error("Verification config must be a JSON object");
  const config = { ...defaults, ...saved, ...values };
  for (const key of ["view", "detailView"]) {
    if (
      config[key] !== undefined &&
      (!config[key] ||
        ![config[key].x, config[key].z, config[key].scale].every(
          Number.isFinite,
        ) ||
        config[key].scale <= 0)
    )
      throw Error(`Invalid ${key}: use finite x, z and a positive scale`);
  }
  config.url = viewerUrl(
    values.url ?? env.MAP_URL ?? saved.url ?? "http://127.0.0.1:5173/",
  );
  config.output = resolve(
    values.output ?? env.MAP_EVIDENCE ?? saved.output ?? output,
  );
  config.webdriver =
    values.webdriver ??
    env.MAP_WEBDRIVER_URL ??
    saved.webdriver ??
    "http://127.0.0.1:4444";
  const driver = new URL(config.webdriver);
  if (
    driver.protocol !== "http:" ||
    driver.username ||
    driver.password ||
    !["127.0.0.1", "localhost", "[::1]"].includes(driver.hostname) ||
    driver.pathname !== "/" ||
    driver.search ||
    driver.hash
  )
    throw Error("WebDriver must be an uncredentialed loopback HTTP origin");
  config.webdriver = driver.origin;
  const count =
    values["expected-regions"] ??
    env.MAP_EXPECTED_REGIONS ??
    saved["expected-regions"];
  config.expectedRegions = count === undefined ? null : Number(count);
  if (
    config.expectedRegions !== null &&
    (!Number.isSafeInteger(config.expectedRegions) ||
      config.expectedRegions < 1)
  )
    throw Error("Expected region count must be a positive integer");
  return config;
}

export function mapReady(expected = null) {
  const map = window.__map;
  if (!map?.ready) return false;
  const state = map.state();
  return (
    state.cached > 0 &&
    state.pending === 0 &&
    Number.isFinite(state.firstVisible) &&
    !state.terrain?.busy &&
    (expected === null || state.cached === expected)
  );
}

export async function waitForMap(page, config) {
  await page.waitForFunction(mapReady, config.expectedRegions, {
    timeout: 90000,
  });
}

export async function aimView(page, config, key = "view", scale = 4) {
  await page.evaluate(
    ({ view, scale }) => {
      if (!view) window.__map.spawn();
      const state = window.__map.state();
      if (view) window.__map.pan(view.x - state.cx, view.z - state.cz);
      window.__map.zoom((view?.scale ?? scale) / state.scale);
    },
    { view: config[key] ?? null, scale },
  );
  await waitForMap(page, { ...config, expectedRegions: null });
}

export function isPlayerResponse(value, viewer) {
  const url = new URL(value);
  return (
    url.origin === new URL(viewer).origin &&
    /\/api\/v1\/worlds\/[A-Za-z0-9_-]{1,80}\/players$/.test(url.pathname) &&
    !url.search
  );
}
