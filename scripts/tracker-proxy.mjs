import { privateReadOrigin } from "./private-origin.mjs";
export function trackerProxy({ origin, world, fingerprint, map }) {
  if (!origin && !map) return null;
  const target = origin ? privateReadOrigin(origin) : null;
  if (
    origin &&
    (!/^[A-Za-z0-9_-]{1,80}$/.test(world ?? "") ||
      !/^[a-f0-9]{64}$/.test(fingerprint ?? ""))
  ) {
    throw Error(
      "Tracking requires an explicit world ID and SHA-256 map binding",
    );
  }
  const path = `/api/v1/worlds/${world}/players`;
  const config = JSON.stringify({
    ...(map ? { map } : {}),
    players: origin
      ? { world_id: world, source_sha256: fingerprint, url: path }
      : null,
  });
  return async (req, res, next) => {
    if (req.url !== "/viewer-config.json" && !req.url?.startsWith("/api/")) {
      next();
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (!["GET", "HEAD"].includes(req.method)) {
      res.writeHead(405).end();
      return;
    }
    if (req.url === "/viewer-config.json") {
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(req.method === "HEAD" ? undefined : config);
      return;
    }
    if (!target || req.url !== path) {
      res.writeHead(404).end();
      return;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    res.once("close", () => controller.abort());
    try {
      const upstream = await fetch(new URL(path, target), {
        redirect: "error",
        signal: controller.signal,
      });
      if (
        !upstream.ok ||
        !upstream.headers.get("content-type")?.startsWith("application/json")
      )
        throw Error("upstream unavailable");
      const reader = upstream.body.getReader();
      const chunks = [];
      let total = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.length;
          if (total > 32768) throw Error("oversize");
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      if (!res.destroyed)
        res
          .writeHead(200, { "Content-Type": "application/json" })
          .end(req.method === "HEAD" ? undefined : Buffer.concat(chunks));
    } catch {
      if (!res.destroyed)
        res
          .writeHead(503, { "Content-Type": "application/json" })
          .end(
            req.method === "HEAD"
              ? undefined
              : '{"error":"tracker unavailable"}',
          );
    } finally {
      clearTimeout(timeout);
    }
  };
}
