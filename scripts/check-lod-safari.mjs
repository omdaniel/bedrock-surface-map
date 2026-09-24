import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { verificationConfig } from "./verification-config.mjs";

const config = verificationConfig({ output: ".local/lod-safari" });
const target = new URL(config.url);
if (
  !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) ||
  !target.searchParams.has("lod") ||
  target.searchParams.get("players") !== "off"
)
  throw Error("Use a loopback synthetic ?lod=... URL with players=off");
async function command(path, body, method = body ? "POST" : "GET") {
  const response = await fetch(config.webdriver + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const { value } = await response.json();
  if (value?.error) throw Error(JSON.stringify(value));
  return value;
}
const session = await command("/session", {
  capabilities: { alwaysMatch: { browserName: "safari" } },
});
const root = `/session/${session.sessionId}`;
const run = (script) => command(`${root}/execute/sync`, { script, args: [] });
const report = {
  capabilities: session.capabilities,
  samples: [],
  stages: [],
  errors: [],
};
await mkdir(config.output, { recursive: true });
async function settle(stage) {
  for (let n = 0; n < 60; n++) {
    const state = await run(
      "return window.__map ? {...window.__map.state(), visibility: document.visibilityState} : null",
    );
    report.samples.push({ stage, state });
    console.log(
      JSON.stringify({
        stage,
        n,
        visibility: state?.visibility,
        pending: state?.lod?.pending,
        gpu: state?.lod?.gpuPending,
        preparations: state?.lod?.preparations,
        kind: state?.lod?.activeKind,
        tiles: state?.lod?.tiles,
        heights: state?.lod?.heights,
        level: state?.lod?.level,
        firstVisible: state?.lod?.firstVisible,
        failures: state?.lod?.failures,
      }),
    );
    if (
      state?.lod?.firstVisible !== null &&
      state?.lod?.tiles > 0 &&
      !state.lod.pending &&
      !state.renderPending
    ) {
      if (state.lod.memory.peakBytes > 200000000)
        throw Error("Memory ceiling exceeded");
      report.stages.push({ stage, state });
      return;
    }
    await delay(500);
  }
  throw Error(`Safari LOD ${stage} did not settle`);
}
async function screenshot(name) {
  await writeFile(
    `${config.output}/${name}.png`,
    Buffer.from(await command(`${root}/screenshot`), "base64"),
  );
}
try {
  await command(`${root}/window/rect`, {
    x: 0,
    y: 0,
    width: 1920,
    height: 1176,
  });
  await command(`${root}/url`, { url: target.href });
  await settle("fit");
  for (const [stage, scale] of [
    ["coarse", 0.12],
    ["fine", 6],
    ["returned-coarse", 0.12],
  ]) {
    await run(`window.__map.zoom(${scale}/window.__map.state().scale)`);
    await settle(stage);
    await screenshot(stage);
  }
} catch (error) {
  report.errors.push(String(error));
  await screenshot("failure").catch(() => {});
  process.exitCode = 1;
} finally {
  await command(root, undefined, "DELETE");
  await writeFile(
    `${config.output}/report.json`,
    JSON.stringify(report, null, 2) + "\n",
  );
}
