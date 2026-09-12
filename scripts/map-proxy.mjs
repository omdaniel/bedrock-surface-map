import { isIP } from "node:net";
import { trackerProxy } from "./tracker-proxy.mjs";
export function mapProxy(options) {
  const players = trackerProxy(options);
  if (!options.terrainOrigin) return players;
  const target = new URL(options.terrainOrigin),
    world = options.world,
    generation = options.generation;
  if (
    target.protocol !== "http:" ||
    target.port !== "8111" ||
    target.username ||
    target.password ||
    target.pathname !== "/" ||
    target.search ||
    target.hash ||
    isIP(target.hostname) !== 4 ||
    !/^(127\.0\.0\.1$|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(
      target.hostname,
    ) ||
    ![world, generation].every((v) => /^[A-Za-z0-9_-]{1,80}$/.test(v ?? ""))
  )
    throw Error(
      "Terrain requires an explicit private IPv4 origin on port 8111 and a world/generation binding",
    );
  const prefix = `/api/v1/worlds/${world}/terrain/`;
  const config = JSON.stringify({
    players: options.origin
      ? {
          world_id: world,
          source_sha256: options.fingerprint,
          generation,
          url: `/api/v1/worlds/${world}/players`,
        }
      : null,
    terrain: { world_id: world, generation, url: `${prefix}manifest.json` },
  });
  return async (req, res, next) => {
    if (req.url === "/viewer-config.json") {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      if (!["GET", "HEAD"].includes(req.method)) {
        res.writeHead(405).end();
        return;
      }
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(req.method === "HEAD" ? undefined : config);
      return;
    }
    if (!req.url?.startsWith(prefix)) {
      if (players) {
        await players(req, res, next);
        return;
      }
      if (req.url?.startsWith("/api/")) {
        res.writeHead(404).end();
        return;
      }
      next();
      return;
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    if (!["GET", "HEAD"].includes(req.method)) {
      res.writeHead(405).end();
      return;
    }
    const suffix = req.url.slice(prefix.length);
    if (
      !/^(manifest\.json|status|objects\/[a-f0-9]{64}\.(json|zst|png|txt))$/.test(
        suffix,
      )
    ) {
      res.writeHead(404).end();
      return;
    }
    const controller = new AbortController(),
      timeout = setTimeout(() => controller.abort(), 10000);
    res.once("close", () => controller.abort());
    try {
      const upstream = await fetch(new URL(req.url, target), {
        method: req.method,
        redirect: "error",
        signal: controller.signal,
        headers: req.headers?.["if-none-match"]
          ? { "If-None-Match": req.headers["if-none-match"] }
          : {},
      });
      if (upstream.status === 304) {
        res
          .writeHead(304, {
            "Cache-Control": "no-cache",
            ...(upstream.headers.get("etag")
              ? { ETag: upstream.headers.get("etag") }
              : {}),
          })
          .end();
        return;
      }
      if (!upstream.ok) {
        res.writeHead(upstream.status === 404 ? 404 : 503).end();
        return;
      }
      const type =
        upstream.headers.get("content-type") ?? "application/octet-stream";
      if (
        ![
          "application/json",
          "application/octet-stream",
          "image/png",
          "text/plain",
        ].some((v) => type.startsWith(v))
      )
        throw Error("Invalid terrain response type");
      const headers = {
        "Content-Type": type,
        "Cache-Control": suffix.startsWith("objects/")
          ? "public, max-age=31536000, immutable"
          : suffix === "status"
            ? "no-store"
            : "no-cache",
      };
      if (upstream.headers.get("etag"))
        headers.ETag = upstream.headers.get("etag");
      if (req.method === "HEAD") {
        res.writeHead(200, headers).end();
        return;
      }
      if (!upstream.body) throw Error("Empty terrain response");
      const reader = upstream.body.getReader(),
        chunks = [];
      let total = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.length;
          if (total > 32 * 1024 * 1024)
            throw Error("Terrain response exceeds limit");
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      if (!res.destroyed)
        res.writeHead(200, headers).end(Buffer.concat(chunks));
    } catch {
      if (!res.destroyed)
        res
          .writeHead(503, { "Content-Type": "application/json" })
          .end(
            req.method === "HEAD"
              ? undefined
              : '{"error":"terrain unavailable"}',
          );
    } finally {
      clearTimeout(timeout);
    }
  };
}
