import { defineConfig } from "vite";
import { resolve } from "node:path";
export default defineConfig({
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
