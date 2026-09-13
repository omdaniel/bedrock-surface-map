import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
const host = "http://127.0.0.1:4444";
async function command(path, body, method = body ? "POST" : "GET") {
  const response = await fetch(host + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const { value } = await response.json();
  if (value?.error) throw new Error(JSON.stringify(value));
  return value;
}
const session = await command("/session", {
  capabilities: { alwaysMatch: { browserName: "safari" } },
});
const root = `/session/${session.sessionId}`;
const script = (code) =>
  command(root + "/execute/sync", { script: code, args: [] });
async function wait(code) {
  for (let n = 0; n < 120; n++) {
    if (await script(code)) return;
    await delay(500);
  }
  throw new Error(
    "Safari readiness timeout: " +
      (await script("return document.body.innerText")),
  );
}
async function screenshot(name) {
  const b64 = await command(root + "/screenshot");
  await writeFile(
    `.local/verification/safari-${name}.png`,
    Buffer.from(b64, "base64"),
  );
}
try {
  await mkdir(".local/verification", { recursive: true });
  await command(root + "/window/rect", {
    x: 0,
    y: 0,
    width: 1920,
    height: 1176,
  });
  await command(root + "/url", { url: "http://127.0.0.1:5173/" });
  await wait(
    "return window.__map?.ready && window.__map.state().cached>0 && window.__map.state().pending===0",
  );
  await screenshot("overview");
  const overview = await script("return window.__map.state()");
  await script("window.__map.spawn()");
  await delay(300);
  await screenshot("detail");
  await script("window.__map.measure().then(r=>window.__safariTiming=r)");
  await wait("return !!window.__safariTiming");
  const timings = await script("return window.__safariTiming");
  const beforeDrag = await script("return window.__map.state().cx");
  await command(root + "/actions", {
    actions: [
      {
        type: "pointer",
        id: "mouse",
        parameters: { pointerType: "mouse" },
        actions: [
          {
            type: "pointerMove",
            duration: 0,
            x: 900,
            y: 500,
            origin: "viewport",
          },
          { type: "pointerDown", button: 0 },
          {
            type: "pointerMove",
            duration: 250,
            x: 980,
            y: 540,
            origin: "viewport",
          },
          { type: "pointerUp", button: 0 },
          {
            type: "pointerMove",
            duration: 0,
            x: 950,
            y: 500,
            origin: "viewport",
          },
        ],
      },
    ],
  });
  const afterDrag = await script("return window.__map.state().cx");
  if (afterDrag === beforeDrag)
    throw new Error("Safari pointer drag did not move the camera");
  const picking = await script(
    'return document.getElementById("inspect").innerText',
  );
  if (!picking.trim()) throw new Error("Safari surface picking is blank");
  await script("window.__map.zoom(4)");
  await delay(300);
  await screenshot("texture");
  await script(
    'document.getElementById("grid").click(); document.getElementById("sun").click(); window.__map.pan(20,20)',
  );
  await delay(300);
  await script("window.__map.loseDevice()");
  await delay(100);
  const loss = await script(
    'return document.getElementById("message").innerText',
  );
  await command(root + "/refresh", {});
  await wait("return window.__map?.ready && window.__map.state().cached>0");
  const report = {
    capabilities: session.capabilities,
    overview,
    timings,
    pointer_drag: true,
    picking,
    device_loss: loss,
    recovered: true,
  };
  await writeFile(
    ".local/verification/safari.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await command(root, undefined, "DELETE");
}
