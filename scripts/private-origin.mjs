import { isIP } from "node:net";

export function privateReadOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw Error("Invalid read-listener origin");
  }
  const privateAddress =
    isIP(url.hostname) === 4 &&
    /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname);
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (
    !privateAddress ||
    !["http:", "https:"].includes(url.protocol) ||
    port < 1 ||
    port > 65535 ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw Error(
      "Configure an explicit private IPv4 HTTP(S) read-listener origin without credentials or a path",
    );
  return url;
}
