// Disposable Docker fixtures change host routes. Chromium can abort a startup
// WASM response during that change. Only this classified, pre-render failure
// receives one fresh navigation; application/GPU/protocol failures still fail.
export function recoverableStartup(
  error,
  state,
  pageErrors,
  env = process.env,
) {
  const transport =
    /WebAssembly compilation aborted: Network error: Response body loading was aborted|net::ERR_NETWORK_CHANGED/;
  return (
    env.GITHUB_ACTIONS === "true" &&
    env.RUNNER_ENVIRONMENT === "github-hosted" &&
    !state.ready &&
    !state.draws &&
    (transport.test(error.message) ||
      transport.test(state.message ?? "") ||
      state.networkChanged === true) &&
    pageErrors.every((message) => transport.test(message))
  );
}

export async function startGeneratedMap(
  page,
  url,
  errors,
  consoleMessages,
  transportFailures = [],
) {
  let recoveries = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForFunction(
        () =>
          window.__map?.ready &&
          window.__map.state().cached > 0 &&
          window.__map.state().pending === 0 &&
          window.__map.state().draws > 0,
        undefined,
        { timeout: 30_000 },
      );
      return recoveries;
    } catch (error) {
      const readState = () =>
        page.evaluate(() => ({
          ready: Boolean(window.__map?.ready),
          draws: window.__map?.state().draws ?? 0,
          message: document.querySelector("#message")?.textContent,
          networkChanged:
            document.body?.innerText.includes("ERR_NETWORK_CHANGED") === true,
        }));
      const state = await readState().catch(async () => {
        await page
          .waitForLoadState("domcontentloaded", { timeout: 5000 })
          .catch(() => {});
        return readState().catch(() => ({}));
      });
      state.networkChanged ||= transportFailures.includes(
        "net::ERR_NETWORK_CHANGED",
      );
      if (attempt || !recoverableStartup(error, state, errors)) throw error;
      recoveries++;
      errors.length = 0;
      consoleMessages.length = 0;
      transportFailures.length = 0;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw Error("unreachable startup state");
}
