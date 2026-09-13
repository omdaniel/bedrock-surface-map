import { defineConfig } from "vite";
import { resolve } from "node:path";
import { mapProxy } from "./scripts/map-proxy.mjs";
const liveProxy = mapProxy({
  origin: process.env.SURFACE_PLAYERS_ORIGIN,
  world: process.env.SURFACE_WORLD_ID,
  fingerprint: process.env.SURFACE_FINGERPRINT,
  terrainOrigin: process.env.SURFACE_TERRAIN_ORIGIN,
  generation: process.env.SURFACE_GENERATION,
});
export default defineConfig({
  plugins: liveProxy
    ? [
        {
          name: "explicit-local-map-proxy",
          configureServer(server) {
            server.middlewares.use(liveProxy);
          },
        },
      ]
    : [],
  root: "web",
  server: {
    host: "127.0.0.1",
    port: 5173,
    fs: {
      strict: true,
      allow: [resolve("web")],
      deny: [
        "**/.local/**",
        "**/.env*",
        "**/*.mcworld",
        "**/*.ldb",
        "**/.git/**",
      ],
    },
  },
  build: { target: "es2022" },
  worker: { format: "es" },
});
