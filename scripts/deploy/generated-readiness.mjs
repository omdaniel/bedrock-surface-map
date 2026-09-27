import { setTimeout as delay } from "node:timers/promises";

const restartStatuses = new Set([502, 503, 504]);
const restartErrors = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
]);

// The request must honor the signal, so an in-flight request shares the deadline.
export async function waitForJson(
  request,
  { label = "JSON endpoint", timeoutMs = 20_000, intervalMs = 200 } = {},
) {
  const controller = new AbortController();
  const { signal } = controller;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let attempts = 0;
  let lastFailure = "no response";
  try {
    while (!signal.aborted) {
      let response;
      attempts++;
      try {
        response = await request(signal);
      } catch (error) {
        if (signal.aborted) break;
        if (!restartErrors.has(error.code)) throw error;
        lastFailure = error.code;
      }
      if (signal.aborted) break;
      if (response) {
        // Do not parse gateway error pages or retry a malformed successful body.
        if (response.status === 200) return JSON.parse(response.body);
        lastFailure = `HTTP ${response.status}`;
        if (!restartStatuses.has(response.status))
          throw Error(`${label}: expected HTTP 200, received ${lastFailure}`);
      }
      try {
        await delay(intervalMs, undefined, { signal });
      } catch (error) {
        if (!signal.aborted) throw error;
      }
    }
    throw Error(
      `${label}: not ready within ${timeoutMs} ms (${attempts} attempts; last failure: ${lastFailure})`,
    );
  } finally {
    clearTimeout(timer);
  }
}
