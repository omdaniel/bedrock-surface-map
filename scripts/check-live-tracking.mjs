import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const ages = [];
  let highestSequence = 0,
    maximumPlayers = 0;
  page.on("response", async (response) => {
    if (!response.url().includes("/api/v1/worlds/")) return;
    try {
      const view = await response.json();
      const s = view.snapshot;
      if (view.status !== "live" || !s || s.sequence <= highestSequence) return;
      highestSequence = s.sequence;
      maximumPlayers = Math.max(maximumPlayers, s.players.length);
      if (s.players.length)
        ages.push({
          age_ms: view.age_ms,
          delivery_ms: Date.now() - s.sampled_at_ms,
        });
    } catch {
      /* Network failures contain no retained payload. */
    }
  });
  await page.goto("https://192.168.68.110:8443/");
  await page.waitForFunction(
    () =>
      window.__map?.ready &&
      window.__map.state().pending === 0 &&
      window.__map.state().cached === 64,
  );
  await page.getByRole("button", { name: "Players", exact: true }).click();
  await page.waitForTimeout(1000);
  const before = await page.evaluate(() => window.__map.state().draws);
  await page.waitForTimeout(60000);
  const after = await page.evaluate(() => window.__map.state().draws);
  const sorted = ages.map((v) => v.delivery_ms).sort((a, b) => a - b);
  const report = {
    samples: ages.length,
    maximum_players: maximumPlayers,
    snapshot_delivery_p50_ms: sorted[Math.floor(sorted.length * 0.5)] ?? null,
    snapshot_delivery_p95_ms: sorted[Math.floor(sorted.length * 0.95)] ?? null,
    snapshot_delivery_max_ms: sorted.at(-1) ?? null,
    terrain_draws_during_stationary_minute: after - before,
    limitation:
      "Snapshot-to-browser timing depends on server/Mac clock alignment; not in-game-action latency. No positions or names retained.",
  };
  await writeFile(
    ".local/tracking/live-delivery.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
