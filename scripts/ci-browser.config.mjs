import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import base from "../playwright.config.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(root, "test-results/ci-browser");

export default defineConfig({
  ...base,
  testDir: resolve(root, "tests"),
  outputDir: output,
  // Shard individual independent tests, not entire slow residency spec files.
  // A runner still owns just one browser worker and retains all test timeouts.
  fullyParallel: true,
  workers: 1,
  // Finish inside the job budget so failure evidence can still be uploaded.
  globalTimeout: 15 * 60 * 1000,
  reporter: [
    ["line"],
    ["json", { outputFile: resolve(root, ".local/ci-browser-results.json") }],
  ],
  use: {
    ...base.use,
    // The Linux Vulkan flags cannot select a WebGPU adapter on macOS. This
    // opt-in local reproduction uses the native package smoke's software path.
    ...(process.env.SURFACE_CI_LOCAL_SOFTWARE === "1"
      ? {
          channel: undefined,
          headless: true,
          launchOptions: {
            args: ["--use-angle=swiftshader", "--enable-unsafe-webgpu"],
          },
        }
      : {}),
  },
  webServer: { ...base.webServer, cwd: root },
});
