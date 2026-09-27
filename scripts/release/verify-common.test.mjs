import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  assertReleaseCommon,
  verifyCommon,
  verifyServedLod,
} from "./verify-common.mjs";

const commit = "a".repeat(40);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (value) => Buffer.from(JSON.stringify(value));

function fixture() {
  const files = new Map([["web/index.html", Buffer.from("synthetic viewer")]]);
  const put = (url, bytes) => {
    files.set(`fixture/${url}`, bytes);
    return { url, sha256: hash(bytes), bytes: bytes.length };
  };
  const object = (bytes, extension = "zst") =>
    put(`objects/${hash(bytes)}.${extension}`, bytes);
  const replace = (ref, bytes) => Object.assign(ref, put(ref.url, bytes));
  const materials = [
    {
      key: "unknown",
      name: "Unknown",
      texture: "unknown",
      tint: 0,
      approximate: true,
      uv: [0, 0, 1, 1],
      average: [1, 0, 1, 1],
    },
  ];
  const atlas = put("atlas.png", Buffer.from("synthetic atlas"));
  const heights = put("heights.zst", Buffer.from("synthetic legacy heights"));
  const region = put("region.zst", Buffer.from("synthetic legacy region"));
  const source = {
    format_version: 1,
    name: "Synthetic release fixture",
    source_sha256: "synthetic-identity",
    bounds: [-256, -256, 0, 0],
    spawn: [-64, 64, -64],
    height_range: [0, 1024],
    materials,
    atlas: atlas.url,
    heights: heights.url,
    heights_sha256: heights.sha256,
    regions: [{ ...region, rx: -1, rz: -1, columns: 65536 }],
  };
  const sourceBytes = json(source);
  put("manifest.json", sourceBytes);
  const makeNode = (key, children = []) => ({
    key,
    children,
    data: object(Buffer.from(`synthetic surface ${JSON.stringify(key)}`)),
    height: object(Buffer.from(`synthetic height ${JSON.stringify(key)}`)),
    ...(key.level === 0
      ? {
          chunks: [
            {
              ...object(Buffer.from(`synthetic BSC1 ${JSON.stringify(key)}`)),
              cx: key.x * 8,
              cz: key.z * 8,
            },
          ],
        }
      : {}),
  });
  const children = [];
  for (const [x, z] of [
    [-2, -2],
    [-1, -2],
    [-2, -1],
    [-1, -1],
  ]) {
    const node = makeNode({ level: 0, x, z });
    children.push({ key: { ...node.key }, index: object(json(node), "json") });
  }
  const node = makeNode({ level: 1, x: -1, z: -1 }, children);
  const root = { key: { ...node.key }, index: object(json(node), "json") };
  const lod = {
    kind: "surface-lod",
    format_version: 1,
    name: source.name,
    bounds: source.bounds,
    spawn: source.spawn,
    source_sha256: hash(sourceBytes),
    generation: `offline-${hash(sourceBytes)}`,
    revision: 1,
    appearance_version: "1",
    height_range: source.height_range,
    material_count: materials.length,
    atlas: object(files.get("fixture/atlas.png"), "png"),
    catalog: [{ ...object(json(materials), "json"), start: 0, count: 1 }],
    roots: [root],
  };
  const save = () => {
    replace(root.index, json(node));
    put("lod.json", json(lod));
  };
  save();
  return { files, source, lod, node, replace, save };
}

async function artifact(t, mutate = () => {}) {
  const value = fixture();
  mutate(value);
  value.save();
  const root = await mkdtemp(join(tmpdir(), "bedrock-common-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [path, bytes] of value.files) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), bytes);
  }
  const manifest = {
    schema_version: 1,
    commit,
    files: [...value.files].map(([path, bytes]) => ({
      path,
      bytes: bytes.length,
      sha256: hash(bytes),
    })),
  };
  await writeFile(join(root, "common-manifest.json"), json(manifest));
  return { root, manifest, ...value };
}

test("common artifact checks source identity, complete LOD graph, all files and hashes", async (t) => {
  const { root } = await artifact(t);
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
});

test("LOD root and every referenced atlas, catalog, index, surface, height and chunk are required", async (t) => {
  const seed = fixture();
  const leaf = JSON.parse(
    seed.files.get(`fixture/${seed.node.children[0].index.url}`),
  );
  for (const path of [
    "lod.json",
    seed.lod.atlas.url,
    seed.lod.catalog[0].url,
    seed.lod.roots[0].index.url,
    seed.node.data.url,
    seed.node.height.url,
    leaf.chunks[0].url,
  ]) {
    const { root, manifest } = await artifact(t);
    await rm(join(root, "fixture", path));
    await assert.rejects(
      verifyCommon(root, commit),
      /missing common artifact file/,
    );
    manifest.files = manifest.files.filter(
      (file) => file.path !== `fixture/${path}`,
    );
    await writeFile(join(root, "common-manifest.json"), json(manifest));
    await assert.rejects(
      verifyCommon(root, commit),
      /missing common fixture reference/,
    );
  }
});

test("sealed but invalid LOD metadata cannot bypass the shared protocol parsers", async (t) => {
  for (const [mutate, pattern] of [
    [
      (v) => {
        v.lod.roots.push(v.lod.roots[0]);
      },
      /root levels/,
    ],
    [
      (v) => {
        v.node.key.x = -2;
      },
      /node identity/,
    ],
    [
      (v) => {
        v.node.children[0].key.x = 0;
      },
      /child identity/,
    ],
    [
      (v) => {
        v.node.children.pop();
      },
      /child coverage/,
    ],
    [
      (v) => {
        v.node.data.url = "../private.mcworld";
      },
      /asset URL/,
    ],
    [
      (v) => {
        v.node.height.url = "https://other.test/height";
      },
      /asset URL/,
    ],
    [
      (v) => {
        v.node.data.bytes = 2097153;
      },
      /asset size/,
    ],
    [
      (v) => {
        v.node.data.sha256 = "f".repeat(64);
      },
      /reference checksum/,
    ],
    [
      (v) => {
        v.node.height = { ...v.node.data, sha256: "f".repeat(64) };
      },
      /conflicting LOD/,
    ],
    [
      (v) => {
        v.replace(v.lod.catalog[0], json([]));
      },
      /catalog length/,
    ],
    [
      (v) => {
        v.replace(
          v.lod.catalog[0],
          json([{ ...v.source.materials[0], tint: "0" }]),
        );
      },
      /material descriptor/,
    ],
    [
      (v) => {
        v.lod.source_sha256 = "f".repeat(64);
      },
      /source\/LOD identity/,
    ],
    [
      (v) => {
        v.lod.name = "another dataset";
      },
      /source\/LOD identity/,
    ],
  ]) {
    const { root } = await artifact(t, mutate);
    await assert.rejects(verifyCommon(root, commit), pattern);
  }
});

test("fixture allowlist is the exact referenced graph, never an objects-directory wildcard", async (t) => {
  for (const path of [
    "fixture/private.mcworld",
    "fixture/objects/unused.zst",
    "fixture/objects/unrelated.json",
  ]) {
    const { root } = await artifact(t, ({ files }) =>
      files.set(path, Buffer.from("private canary")),
    );
    await assert.rejects(
      verifyCommon(root, commit),
      /unreferenced common fixture file/,
    );
  }
});

test("common artifact rejects symlinks, unsafe inventory paths and duplicate inventory entries", async (t) => {
  const { root, manifest } = await artifact(t);
  await rm(join(root, "web/index.html"));
  await symlink(
    join(root, "fixture/manifest.json"),
    join(root, "web/index.html"),
  );
  await assert.rejects(verifyCommon(root, commit), /symlink/);
  await rm(join(root, "web/index.html"));
  await writeFile(join(root, "web/index.html"), "synthetic viewer");
  for (const path of [
    "../escape",
    "web\\index.html",
    "/absolute",
    "web/./index.html",
    "web/control\nname",
  ]) {
    const changed = structuredClone(manifest);
    changed.files[0].path = path;
    await writeFile(join(root, "common-manifest.json"), json(changed));
    await assert.rejects(verifyCommon(root, commit), /inventory/);
  }
  manifest.files.push(manifest.files[0]);
  await writeFile(join(root, "common-manifest.json"), json(manifest));
  await assert.rejects(verifyCommon(root, commit), /inventory/);
});

test("common/release mapping seals LOD objects at the existing fixture resource path", async (t) => {
  const { manifest } = await artifact(t);
  const release = {
    commit,
    files: manifest.files.map((file) => ({
      ...file,
      path: file.path.startsWith("fixture/")
        ? `share/bedrock-surface-map/fixtures/surface-v1/${file.path.slice(8)}`
        : `share/bedrock-surface-map/${file.path}`,
    })),
  };
  assert.doesNotThrow(() => assertReleaseCommon(manifest, release));
  release.files.find((file) => file.path.endsWith("/lod.json")).sha256 =
    "f".repeat(64);
  assert.throws(
    () => assertReleaseCommon(manifest, release),
    /common resource mismatch/,
  );
});

test("served LOD checks configuration and all references at both root and subpath mounts", async () => {
  const { files } = fixture();
  for (const mount of ["/", "/map/"]) {
    const base = new URL(`http://127.0.0.1:5195${mount}`),
      requests = [];
    const result = await verifyServedLod(base, async function (url, options) {
      assert.equal(this, globalThis);
      assert.equal(options.redirect, "error");
      assert.equal(options.cache, "no-cache");
      requests.push(url.href);
      assert.ok(url.href.startsWith(base.href));
      if (url.pathname === `${mount}viewer-config.json`)
        return Response.json({ lod_url: "maps/synthetic/lod.json" });
      const path = url.pathname.slice(`${mount}maps/synthetic/`.length);
      const bytes = files.get(`fixture/${path}`);
      assert.ok(bytes, `unexpected reference ${path}`);
      return new Response(bytes, {
        headers: { "Content-Length": String(bytes.length) },
      });
    });
    assert.equal(result.url, new URL("maps/synthetic/lod.json", base).href);
    assert.equal(result.nodes, 5);
    assert.ok(result.objects > 10);
    assert.ok(requests.length > result.objects);
  }
});

test("served LOD checks reject absent bindings, escaped mounts, HTTP errors and corrupt objects", async () => {
  for (const lod_url of [
    undefined,
    "https://other.test/lod.json",
    "/maps/synthetic/lod.json",
    "http://user:secret@127.0.0.1:5195/map/lod.json",
    "maps/synthetic/lod.json?secret",
    "maps/synthetic/manifest.json",
  ]) {
    let requests = 0;
    await assert.rejects(
      verifyServedLod("http://127.0.0.1:5195/map/", async () => {
        requests++;
        return Response.json({ lod_url });
      }),
    );
    assert.equal(requests, 1);
  }
  await assert.rejects(
    verifyServedLod(
      "http://127.0.0.1:5195/",
      async () =>
        new Response("x", {
          headers: { "Content-Length": "16385" },
        }),
    ),
    /length limit/,
  );
  const { files, node } = fixture();
  for (const failure of ["missing", "corrupt"]) {
    await assert.rejects(
      verifyServedLod("http://127.0.0.1:5195/", async (url) => {
        if (url.pathname === "/viewer-config.json")
          return Response.json({ lod_url: "maps/synthetic/lod.json" });
        const path = url.pathname.slice("/maps/synthetic/".length);
        if (path === node.data.url)
          return failure === "missing"
            ? new Response(null, { status: 404 })
            : new Response("corrupt");
        return new Response(files.get(`fixture/${path}`));
      }),
      failure === "missing" ? /HTTP 404/ : /reference checksum/,
    );
  }
});
