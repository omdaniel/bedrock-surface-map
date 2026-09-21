import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const rootName = "bedrock-surface-map-v0.1.0-linux-arm64";

async function rejection(entry, make, pattern) {
  const root = await mkdtemp(join(tmpdir(), "bedrock-audit-test-"));
  try {
    const release = join(root, rootName);
    await mkdir(release);
    await make(join(release, entry));
    const archive = join(root, "candidate.tar.gz");
    execFileSync(
      "tar",
      ["--format=ustar", "-C", root, "-czf", archive, rootName],
      { env: { ...process.env, COPYFILE_DISABLE: "1" } },
    );
    const result = spawnSync(
      process.execPath,
      ["scripts/release/audit.mjs", archive],
      { encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, pattern);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("audit rejects raw world canaries and hidden AppleDouble members", async () => {
  await rejection(
    "private.mcworld",
    (path) => writeFile(path, "private canary"),
    /forbidden path/,
  );
  await rejection(
    "._manifest.json",
    (path) => writeFile(path, "metadata canary"),
    /forbidden path/,
  );
});

test("audit rejects symlinks before extraction", async () => {
  await rejection(
    "linked",
    (path) => symlink("/etc/passwd", path),
    /link or unsupported/,
  );
});
