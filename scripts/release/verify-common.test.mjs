import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { verifyCommon, validateOptionalLodConfig } from "./verify-common.mjs";

test("common artifact checks source identity, all files and hashes", async () => {
  const root = await mkdtemp(join(tmpdir(), "bedrock-common-test-"));
  try {
    await mkdir(join(root, "web"));
    const content = Buffer.from("synthetic fixture");
    await writeFile(join(root, "web/index.html"), content);
    const config = Buffer.from(
      JSON.stringify({ lod_url: "maps/fixture/lod.json" }),
    );
    await writeFile(join(root, "web/viewer-config.json"), config);
    const commit = "a".repeat(40);
    const manifest = {
      schema_version: 1,
      commit,
      files: [
        {
          path: "web/viewer-config.json",
          bytes: config.length,
          sha256: createHash("sha256").update(config).digest("hex"),
        },
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

test("package configuration allows optional local LOD URLs without remote or path aliases", () => {
  for (const config of [
    {},
    { map: "maps/world/manifest.json" },
    { lod_url: "maps/world/lod.json" },
    { lod_url: "/maps/world/lod.json" },
    {
      lod_url: "/api/v1/worlds/world/terrain/lod.json",
      terrain: {
        url: "/api/v1/worlds/world/terrain/manifest.json",
        world_id: "world",
        generation: "generation",
      },
    },
  ])
    assert.doesNotThrow(() => validateOptionalLodConfig(config));
  for (const config of [
    { terrain: { lod_url: "/api/v1/worlds/world/terrain/lod.json" } },
    {
      lod_url: "maps/world/lod.json",
      terrain: { lod_url: "maps/other/lod.json" },
    },
  ])
    assert.throws(() => validateOptionalLodConfig(config), /top-level/);
  for (const lod_url of [
    null,
    1,
    "",
    "https://example.test/lod.json",
    "//example.test/lod.json",
    "maps/../lod.json",
    "maps/./lod.json",
    "maps//lod.json",
    "maps/%2e/lod.json",
    "maps/lod.json?url=remote",
    "maps/lod.json#fragment",
    "maps\\lod.json",
    "a".repeat(513) + ".json",
  ])
    for (const config of [{ lod_url }, { terrain: { lod_url } }])
      assert.throws(() => validateOptionalLodConfig(config), /lod_url/);
});
