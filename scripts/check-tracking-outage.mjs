import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";

// Observe an independently controlled collector outage. Never mutate the server.
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  await page.goto("https://192.168.68.110:8443/");
  await page.waitForFunction(
    () =>
      window.__map?.ready &&
      window.__map.state().cached === 64 &&
      window.__map.state().pending === 0 &&
      document.querySelectorAll(".player-row").length > 0,
    undefined,
    { timeout: 90000 },
  );
  await page.getByRole("button", { name: "Players", exact: true }).click();
  const before = await page.evaluate(() => window.__map.state().draws);
  console.log(
    "Observer ready; stop only the collector using the guarded VM test.",
  );
  await page.waitForFunction(
    () => document.querySelector("#player-markers").classList.contains("stale"),
    undefined,
    { timeout: 120000 },
  );
  const stale = Date.now();
  await page.waitForFunction(
    () =>
      document.querySelector(".players-status").textContent ===
        "Player positions unavailable" &&
      document.querySelectorAll(".player-row,.player-marker").length === 0,
    undefined,
    { timeout: 25000 },
  );
  const expired = Date.now();
  await page.waitForFunction(
    () =>
      document.querySelector(".players-status").textContent.includes("online"),
    undefined,
    { timeout: 660000 },
  );
  const report = {
    stale_to_expired_ms: expired - stale,
    expired_to_live_ms: Date.now() - expired,
    terrain_draws_during_outage:
      (await page.evaluate(() => window.__map.state().draws)) - before,
    recovered_players: await page.locator(".player-row").count(),
    recovered_without_reload: true,
    limitation:
      "Game-action latency and server tick cost are not measured here.",
  };
  assert.equal(report.terrain_draws_during_outage, 0);
  await mkdir(".local/tracking", { recursive: true });
  await writeFile(
    ".local/tracking/outage-observation.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
