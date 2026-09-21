import { execFileSync } from "node:child_process";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const output = resolve(process.argv[2] ?? ".local/release/common");
const staging = resolve(".local/release/web-public");

await rm(output, { recursive: true, force: true });
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true, mode: 0o700 });
await mkdir(output, { recursive: true, mode: 0o700 });

execFileSync(process.execPath, ["scripts/wasm.mjs"], { stdio: "inherit" });
// Only the versioned WASM package is needed from the source tree. The public
// directory is intentionally not copied: it can contain a local imported map.
await cp("web/pkg", resolve(staging, "pkg"), { recursive: true });
await writeFile(resolve(staging, "viewer-config.json"), "{}\n", {
  mode: 0o600,
});
execFileSync(
  "npm",
  ["exec", "--", "vite", "build", "--config", "vite.config.ts"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      SURFACE_BASE_PATH: "./",
      SURFACE_DEMO_PUBLIC: staging,
      SURFACE_DEMO_DIST: resolve(output, "web"),
      SURFACE_PLAYERS_ORIGIN: "",
      SURFACE_TERRAIN_ORIGIN: "",
      SURFACE_WORLD_ID: "",
      SURFACE_FINGERPRINT: "",
      SURFACE_MAP: "",
      SURFACE_GENERATION: "",
    },
  },
);
console.log(`Packaged viewer resources: ${output}`);
