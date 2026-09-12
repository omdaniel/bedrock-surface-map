import { world } from "@minecraft/server";
import { variables } from "@minecraft/server-admin";
import {
  http,
  HttpRequest,
  HttpRequestMethod,
  HttpHeader,
} from "@minecraft/server-net";

const base = variables.get("probe_url");
if (typeof base !== "string" || !/^http:\/\/172\.\d+\.\d+\.\d+:\d+$/.test(base))
  throw Error("Private test endpoint required");
const endpoint = base;
async function request(path: string, body = "", delay = 500, timeout = 2) {
  try {
    const req = new HttpRequest(endpoint + path);
    req.method = HttpRequestMethod.Post;
    req.body = body;
    req.timeout = timeout;
    req.headers = [new HttpHeader("x-test-delay", String(delay))];
    return (await http.request(req)).status;
  } catch (error) {
    const name = error instanceof Error ? error.name : "UnknownError";
    return [
      "UriNotAllowedError",
      "RequestBodyTooLargeError",
      "HttpRequestLimitExceededError",
      "InternalHttpRequestError",
    ].includes(name)
      ? name
      : "OtherError";
  }
}
world.afterEvents.worldLoad.subscribe(() => {
  void (async () => {
    const uri = await request("/forbidden");
    const body = await request("/slow", "x".repeat(16385));
    const first = request("/slow");
    const concurrent = await request("/slow");
    const allowed = await first;
    const started = Date.now();
    const timeout = await request("/slow", "", 3000, 1);
    console.warn(
      "SURFACE_NET_PROBE " +
        JSON.stringify({
          uri,
          body,
          concurrent,
          allowed,
          timeout,
          timeout_ms: Date.now() - started,
        }),
    );
  })();
});
