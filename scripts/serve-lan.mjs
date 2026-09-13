import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { preview } from "vite";

const { values } = parseArgs({
  options: { host: { type: "string" } },
});
const host = values.host;
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

await readFile("web/dist/index.html");
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
  preview: {
    host,
    port: 8443,
    strictPort: true,
    cors: false,
    https: { cert: await readFile(certificate), key: await readFile(key) },
  },
});
try {
  await new Promise((accept, reject) => {
    certificateServer.once("error", reject);
    certificateServer.listen(8444, host, accept);
  });
} catch (error) {
  await viewer.close();
  throw error;
}
console.log(`LAN viewer: https://${host}:8443/`);
console.log(`Public CA: http://${host}:8444/bedrock-surface-map-ca.crt`);
console.log("Trust the public CA on the viewing device. Never share CA keys.");
console.log("LAN only, no authentication: use on a trusted home network.");
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    certificateServer.close();
    await viewer.close();
    process.exit(0);
  });
}
