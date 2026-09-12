import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const { values } = parseArgs({
  options: {
    browser: { type: "string", default: "chrome" },
    url: { type: "string", default: "https://192.168.68.110:8443/" },
  },
});
if (!["chrome", "safari"].includes(values.browser))
  throw Error("Choose chrome or safari");
const origin = new URL(values.url);
if (!["192.168.68.110", "127.0.0.1", "localhost"].includes(origin.hostname))
  throw Error("Local verification origin required");
await mkdir(".local/tracking", { recursive: true });

let navigate, evaluate, close, screenshot;
if (values.browser === "chrome") {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1176 },
    deviceScaleFactor: 1,
  });
  navigate = (url) => page.goto(url);
  evaluate = (code) => page.evaluate(code);
  close = () => browser.close();
  screenshot = (path) => page.screenshot({ path });
} else {
  // Start safaridriver separately; never alter Safari's automation/security settings.
  const command = async (path, body, method = body ? "POST" : "GET") => {
    const response = await fetch("http://127.0.0.1:4444" + path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const { value } = await response.json();
    if (value?.error) throw Error(value.message);
    return value;
  };
  const session = await command("/session", {
    capabilities: { alwaysMatch: { browserName: "safari" } },
  });
  const root = `/session/${session.sessionId}`;
  await command(root + "/window/rect", {
    x: 0,
    y: 0,
    width: 960,
    height: 688,
  });
  navigate = (url) => command(root + "/url", { url });
  evaluate = (code) =>
    command(root + "/execute/sync", { script: "return " + code, args: [] });
  close = () => command(root, undefined, "DELETE");
  screenshot = async (path) =>
    writeFile(path, Buffer.from(await command(root + "/screenshot"), "base64"));
}
async function wait(code) {
  for (let n = 0; n < 160; n++) {
    if (await evaluate(code)) return;
    await delay(500);
  }
  throw Error("Map verification readiness timeout");
}
async function measure() {
  await evaluate(
    "(() => { window.__timingResult=null; window.__map.measure().then(r=>window.__timingResult=r); return true; })()",
  );
  await wait("!!window.__timingResult");
  return evaluate("window.__timingResult");
}
const runs = [];
try {
  for (const mode of ["off", "on", "on", "off"]) {
    const url = new URL(values.url);
    if (mode === "off") url.searchParams.set("players", "off");
    await navigate(url.href);
    await wait(
      "window.__map?.ready && window.__map.state().cached === 64 && window.__map.state().pending === 0",
    );
    await evaluate(
      "(() => {window.__map.spawn(); window.__map.zoom(1/devicePixelRatio); return true})()",
    );
    await delay(1000);
    if (mode === "on")
      await wait(
        "document.querySelector('.players-status').textContent.includes('online')",
      );
    await measure();
    const timing = await measure();
    const count = await evaluate(
      "document.querySelectorAll('.player-row').length",
    );
    runs.push({ mode, players: count, ...timing });
    if (mode === "on")
      await screenshot(
        `.local/tracking/${values.browser}-tracking-performance.png`,
      );
  }
  const report = {
    browser: values.browser,
    user_agent: await evaluate("navigator.userAgent"),
    method:
      "ABBA controlled pan with one warmup before each run; target 1920x1080 physical canvas, 3 physical pixels/block; native DPR retained; frame intervals, not GPU timestamps; no positions retained",
    runs,
  };
  await writeFile(
    `.local/tracking/${values.browser}-tracking-performance.json`,
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await close();
}
