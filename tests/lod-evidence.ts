import { writeFile } from "node:fs/promises";
import type { Page, TestInfo } from "@playwright/test";

export async function captureLodFailure(page: Page, info: TestInfo) {
  if (info.status === info.expectedStatus || page.isClosed()) return;
  const value = await page
    .evaluate(() => ({
      ready: window.__map?.ready,
      state: window.__map?.state(),
      visibility: document.visibilityState,
      message: document.querySelector("#message")?.textContent,
    }))
    .catch((error: unknown) => ({ error: String(error) }));
  const path = info.outputPath("lod-failure-state.json");
  await writeFile(path, JSON.stringify(value, null, 2));
  await info.attach("lod-failure-state", {
    path,
    contentType: "application/json",
  });
}
