import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { verifyCommon } from "./verify-common.mjs";

test("common artifact checks source identity, all files and hashes", async () => {
  const root = await mkdtemp(join(tmpdir(), "bedrock-common-test-"));
  try {
    await mkdir(join(root, "web"));
    const content = Buffer.from("synthetic fixture");
    await writeFile(join(root, "web/index.html"), content);
    const commit = "a".repeat(40);
    const manifest = {
      schema_version: 1,
      commit,
      files: [
        {
          path: "web/index.html",
          bytes: content.length,
          sha256: createHash("sha256").update(content).digest("hex"),
        },
      ],
    };
    await writeFile(
      join(root, "common-manifest.json"),
      JSON.stringify(manifest),
    );
    await verifyCommon(root, commit);
    await assert.rejects(verifyCommon(root, "b".repeat(40)), /source identity/);
    await writeFile(join(root, "web/private.mcworld"), "canary");
    await assert.rejects(verifyCommon(root, commit), /unlisted/);
    await rm(join(root, "web/private.mcworld"));
    await writeFile(join(root, "web/index.html"), "corrupt");
    await assert.rejects(verifyCommon(root, commit), /checksum/);
    assert.equal(
      (await readFile(join(root, "common-manifest.json"), "utf8")).length > 0,
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
