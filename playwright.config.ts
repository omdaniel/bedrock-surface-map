import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests",
  workers: 1,
  timeout: 60000,
  use: {
    baseURL: "http://127.0.0.1:5173",
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    channel: process.env.CI ? undefined : "chrome",
    headless: true,
    launchOptions: {
      args: process.env.CI
        ? [
            "--enable-unsafe-webgpu",
            "--use-angle=swiftshader",
            "--enable-features=Vulkan",
          ]
        : [],
    },
  },
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: !process.env.CI,
  },
});
