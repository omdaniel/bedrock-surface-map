import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { preview } from "vite";
import { mapProxy } from "./map-proxy.mjs";

const { values } = parseArgs({
  options: {
    host: { type: "string" },
    "players-origin": { type: "string" },
    "world-id": { type: "string" },
    "map-fingerprint": { type: "string" },
    map: { type: "string" },
    "terrain-origin": { type: "string" },
    generation: { type: "string" },
    port: { type: "string", default: "8443" },
    "ca-port": { type: "string", default: "8444" },
    "out-dir": { type: "string", default: "web/dist" },
    "no-ca-download": { type: "boolean", default: false },
  },
});
const host = values.host;
const port = Number(values.port),
  caPort = Number(values["ca-port"]),
  outDir = resolve(values["out-dir"]);
if (
  ![port, caPort].every(
    (p) => Number.isInteger(p) && p >= 1024 && p <= 65535,
  ) ||
  (!values["no-ca-download"] && port === caPort)
)
  throw Error("Pass an unprivileged TCP port between 1024 and 65535");
const playerProxy = mapProxy({
  origin: values["players-origin"],
  world: values["world-id"],
  fingerprint: values["map-fingerprint"],
  map: values.map,
  terrainOrigin: values["terrain-origin"],
  generation: values.generation,
});
const localAddresses = Object.values(networkInterfaces())
  .flat()
  .filter(Boolean)
  .map((address) => address.address);
if (
  !host ||
  isIP(host) !== 4 ||
  !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) ||
  !localAddresses.includes(host)
) {
  throw new Error("Pass --host with this computer's private LAN IPv4 address.");
}

await readFile(resolve(outDir, "index.html"));
const directory = resolve(".local/lan");
const caDirectory = resolve(directory, "ca");
await mkdir(caDirectory, { recursive: true, mode: 0o700 });
await chmod(directory, 0o700);
await chmod(caDirectory, 0o700);
const certificate = resolve(directory, "server.pem");
const key = resolve(directory, "server-key.pem");
const generated = spawnSync(
  "mkcert",
  ["-cert-file", certificate, "-key-file", key, host],
  {
    env: { ...process.env, CAROOT: caDirectory },
    stdio: "inherit",
  },
);
if (generated.error || generated.status !== 0) {
  throw new Error("Certificate generation failed. Install mkcert first.");
}
await chmod(key, 0o600);
await chmod(resolve(caDirectory, "rootCA-key.pem"), 0o600);

// Only the public CA certificate is available on the HTTP bootstrap endpoint.
// The CA key and server key never enter the web root or an HTTP response.
const publicCA = await readFile(resolve(caDirectory, "rootCA.pem"));
const certificateServer = createServer((request, response) => {
  if (
    !["GET", "HEAD"].includes(request.method) ||
    request.url !== "/bedrock-surface-map-ca.crt"
  ) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, {
    "Content-Type": "application/x-x509-ca-cert",
    "Content-Disposition": 'attachment; filename="bedrock-surface-map-ca.crt"',
    "Content-Length": publicCA.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(request.method === "HEAD" ? undefined : publicCA);
});
const viewer = await preview({
  configFile: resolve("vite.config.ts"),
  build: { outDir },
  plugins: playerProxy
    ? [
        {
          name: "read-only-player-proxy",
          configurePreviewServer(server) {
            server.middlewares.use(playerProxy);
          },
        },
      ]
    : [],
  preview: {
    host,
    port,
    strictPort: true,
    cors: false,
    https: { cert: await readFile(certificate), key: await readFile(key) },
  },
});
try {
  if (!values["no-ca-download"])
    await new Promise((accept, reject) => {
      certificateServer.once("error", reject);
      certificateServer.listen(caPort, host, accept);
    });
} catch (error) {
  await viewer.close();
  throw error;
}
console.log(`LAN viewer: https://${host}:${port}/`);
if (!values["no-ca-download"]) {
  console.log(`Public CA: http://${host}:${caPort}/bedrock-surface-map-ca.crt`);
  console.log(
    "Trust the public CA on the viewing device. Never share CA keys.",
  );
}
console.log("LAN only, no authentication: use on a trusted home network.");
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    certificateServer.close();
    await viewer.close();
    process.exit(0);
  });
}
