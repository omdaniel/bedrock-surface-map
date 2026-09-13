import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const { values } = parseArgs({
  options: { service: { type: "string", default: "tracking" } },
});
if (!["tracking", "terrain"].includes(values.service))
  throw Error("Choose tracking or terrain");
const terrain = values.service === "terrain";

// Observe an independently controlled collector outage. Never mutate the server.
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  await page.goto("https://192.168.68.110:8443/");
  await page.waitForFunction(
    (terrain) =>
      window.__map?.ready &&
      window.__map.state().cached > 0 &&
      window.__map.state().pending === 0 &&
      window.__map.state().draws > 0 &&
      (terrain
        ? window.__map.state().terrain !== null &&
          document.querySelector(".local-state").textContent ===
            "Terrain live" &&
          /online/.test(document.querySelector(".players-status").textContent)
        : document.querySelectorAll(".player-row").length > 0),
    terrain,
    { timeout: 90000 },
  );
  await page.getByRole("button", { name: "Players", exact: true }).click();
  const before = await page.evaluate(() => window.__map.state().draws);
  console.log(
    "Observer ready; stop only the collector using the guarded VM test.",
  );
  if (terrain) {
    const camera = await page.evaluate(() => window.__map.state());
    let responses = 0,
      staleResponses = 0,
      unavailableBodies = 0,
      playerUiChecks = 0;
    const responseDiagnostics = {};
    page.on("response", async (response) => {
      if (!response.url().endsWith("/bedrock-survival/players")) return;
      try {
        const value = await response.json();
        responses++;
        if (value.status !== "live" || value.age_ms > 10000) {
          staleResponses++;
          const key = `${response.status()} ${value.status ?? "missing status"}`;
          responseDiagnostics[key] = (responseDiagnostics[key] ?? 0) + 1;
        }
      } catch (error) {
        const key = String(error).slice(0, 160);
        // Chrome can discard a streamed body after the app has consumed it.
        // This is missing debugger evidence, not an unavailable player feed.
        if (key.includes("No data found for resource with given identifier"))
          unavailableBodies++;
        else staleResponses++;
        responseDiagnostics[key] = (responseDiagnostics[key] ?? 0) + 1;
      }
    });
    let delayed = false,
      recovered = false;
    const deadline = Date.now() + 660000;
    while (Date.now() < deadline) {
      const status = await page.locator(".players-status").textContent();
      assert.match(
        status,
        /^\d+ online$/,
        "Player UI lost freshness during terrain outage",
      );
      playerUiChecks++;
      const state = await page.locator(".local-state").textContent();
      if (state === "Terrain delayed") delayed = true;
      if (delayed && state === "Terrain live") {
        recovered = true;
        break;
      }
      await delay(1000);
    }
    assert.ok(
      recovered,
      "Terrain did not recover within the guarded test deadline",
    );
    const after = await page.evaluate(() => window.__map.state());
    const report = {
      service: "terrain",
      recovered_without_reload: true,
      terrain_draws_during_outage: after.draws - before,
      player_responses: responses,
      stale_player_responses: staleResponses,
      unavailable_debugger_bodies: unavailableBodies,
      fresh_player_ui_checks: playerUiChecks,
      response_diagnostics: responseDiagnostics,
      camera_preserved:
        after.cx === camera.cx &&
        after.cz === camera.cz &&
        after.scale === camera.scale,
      memory: after.memory,
      limitation:
        "No movement or edit latency is inferred from an idle outage test.",
    };
    await mkdir(".local/tracking", { recursive: true });
    await writeFile(
      ".local/tracking/terrain-outage-observation.json",
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report, null, 2));
    assert.equal(report.terrain_draws_during_outage, 0);
    assert.ok(responses >= 5);
    assert.equal(staleResponses, 0);
    assert.ok(report.camera_preserved);
    assert.ok(after.memory <= 256 * 1024 ** 2);
  } else {
    await page.waitForFunction(
      () =>
        document.querySelector("#player-markers").classList.contains("stale"),
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
        document
          .querySelector(".players-status")
          .textContent.includes("online"),
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
  }
} finally {
  await browser.close();
}
