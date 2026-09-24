import { defineConfig } from "@playwright/test";
const port = Number(process.env.SURFACE_TEST_PORT ?? 5173);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw Error("Invalid SURFACE_TEST_PORT");
const baseURL = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: "tests",
  testMatch: "**/*.spec.ts",
  workers: 1,
  timeout: 60000,
  use: {
    baseURL,
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    channel: process.env.CI ? undefined : "chrome",
    headless: !process.env.CI,
    launchOptions: {
      args: process.env.CI
        ? [
            "--enable-unsafe-webgpu",
            "--enable-features=Vulkan",
            "--use-angle=vulkan",
            "--use-vulkan=swiftshader",
            "--use-webgpu-adapter=swiftshader",
            "--disable-vulkan-surface",
          ]
        : [],
    },
  },
  webServer: {
    command: `npm run dev -- --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
  },
});
