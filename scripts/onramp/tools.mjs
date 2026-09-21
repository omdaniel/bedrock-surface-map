import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { run } from "./process.mjs";

export async function readPins(root) {
  return JSON.parse(
    await readFile(resolve(root, "sources/build-tools.json"), "utf8"),
  );
}

export function platform() {
  return platformFor(process.platform, process.arch);
}

export function platformFor(os, arch) {
  if (os === "darwin" && arch === "arm64") return "darwin-arm64";
  if (os === "linux" && arch === "x64") return "linux-x86_64";
  if (os === "linux" && arch === "arm64") return "linux-aarch64";
  throw new Error(`Unsupported developer-tool platform: ${os}-${arch}`);
}

export async function checksum(path) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}

export async function installGitleaks(root, pins, offline = false) {
  const entry = pins.gitleaks.archives[platform()];
  if (!entry) throw new Error("No verified Gitleaks archive for this platform");
  const destination = resolve(
    root,
    ".sources/tools/gitleaks",
    pins.gitleaks.version,
    platform(),
  );
  const binary = resolve(destination, "gitleaks");
  const archive = resolve(destination, "archive.tar.gz");
  try {
    const metadata = await lstat(archive);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      (await checksum(archive)) !== entry.sha256
    )
      throw new Error("Cached Gitleaks archive checksum mismatch");
    run("tar", ["-xzf", archive, "-C", destination, "gitleaks"]);
    run("chmod", ["0755", binary]);
    return binary;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (offline)
    throw new Error(
      `Offline setup is missing verified Gitleaks archive: ${archive}`,
    );
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const partial = `${archive}.part`;
  await rm(partial, { force: true });
  const response = await fetch(entry.url, {
    // GitHub release URLs redirect to a short-lived HTTPS object URL. The
    // pinned archive digest still authenticates the bytes before extraction.
    redirect: "follow",
    signal: AbortSignal.timeout(300000),
  });
  if (!response.ok || !response.body)
    throw new Error(`Gitleaks download failed: ${response.status}`);
  if (new URL(response.url).protocol !== "https:")
    throw new Error("Gitleaks download redirected to a non-HTTPS URL");
  const file = await (
    await import("node:fs/promises")
  ).open(partial, "w", 0o600);
  await pipeline(Readable.fromWeb(response.body), file.createWriteStream());
  if ((await checksum(partial)) !== entry.sha256)
    throw new Error("Gitleaks checksum mismatch; archive was not installed");
  await rename(partial, archive);
  run("tar", ["-xzf", archive, "-C", destination, "gitleaks"]);
  run("chmod", ["0755", binary]);
  return binary;
}
