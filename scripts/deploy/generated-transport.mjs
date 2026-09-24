import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256 } from "../release/oci.mjs";

// Only issuance and gateway port assignment differ from the generated stack.
// Runtime identity checks still verify the explicit test configuration hashes.
export async function fixtureTransport(root) {
  const caddyPath = join(root, "prepared/gateway/Caddyfile");
  const caddy = (await readFile(caddyPath, "utf8")).replace(
    "https://map.example.test {",
    "https://map.example.test {\n  tls internal",
  );
  await writeFile(caddyPath, caddy, { mode: 0o600 });
  const markerPath = join(root, "prepared/preparation.json");
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  marker.immutable_files["gateway/Caddyfile"] = sha256(Buffer.from(caddy));
  await writeFile(markerPath, JSON.stringify(marker), { mode: 0o600 });
  const generated = JSON.parse(
    await readFile(join(root, "compose.yaml"), "utf8"),
  );
  for (const port of generated.services.gateway.ports) {
    port.published = "0";
    port.host_ip = "127.0.0.1";
  }
  const path = join(root, "compose-test.json");
  await writeFile(path, JSON.stringify(generated), { mode: 0o600 });
  return { path, marker, generated };
}
