import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".css": "text/css",
  ".png": "image/png",
  ".zst": "application/octet-stream",
};
export async function serveDemo(port = 5190) {
  const root = resolve(".local/demo-dist");
  const base = "/bedrock-surface-map/";
  const server = createServer(async (req, res) => {
    try {
      if (!["GET", "HEAD"].includes(req.method)) {
        res.writeHead(405);
        res.end();
        return;
      }
      const path = decodeURIComponent(
        new URL(req.url, "http://localhost").pathname,
      );
      if (!path.startsWith(base)) throw Error("path");
      const file = resolve(root, path.slice(base.length) || "index.html");
      if (!file.startsWith(root + sep) || !(await stat(file)).isFile())
        throw Error("file");
      const bytes = await readFile(file);
      res.writeHead(200, {
        "content-type": mime[extname(file)] ?? "application/octet-stream",
        "content-length": bytes.length,
        "cache-control": "no-cache",
        "x-content-type-options": "nosniff",
      });
      res.end(req.method === "HEAD" ? undefined : bytes);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
  });
  await new Promise((ok, no) => {
    server.once("error", no);
    server.listen(port, "127.0.0.1", ok);
  });
  return server;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await serveDemo();
  console.log("http://127.0.0.1:5190/bedrock-surface-map/");
}
