import { defineConfig, devices } from '@playwright/test';
const base = process.env.DOCS_BASE_PATH || '/';
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  use: { baseURL: `http://127.0.0.1:4178${base}`, screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], channel: process.env.CI ? undefined : 'chrome' } },
    { name: 'mobile-layout', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium', channel: process.env.CI ? undefined : 'chrome' } },
  ],
  webServer: { command: 'npm run preview -- --port 4178 --strictPort', url: `http://127.0.0.1:4178${base}`, reuseExistingServer: false },
});
