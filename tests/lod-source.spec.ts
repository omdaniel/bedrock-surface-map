import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import type { Material } from "../web/src/types";
import type { LodManifest } from "../web/src/lod/protocol";
import type { PyramidSource } from "../web/src/lod/source";

declare global {
  interface Window {
    __sourceCatalogTest: { source: PyramidSource; accepted: LodManifest };
  }
}

function object(value: unknown) {
  const body = JSON.stringify(value),
    sha256 = createHash("sha256").update(body).digest("hex");
  return {
    body,
    ref: {
      url: `objects/${sha256}.json`,
      sha256,
      bytes: Buffer.byteLength(body),
    },
  };
}
const dummy = object({ kind: "unused payload" });
const child = object({
  key: { level: 0, x: 0, z: 0 },
  data: dummy.ref,
  height: dummy.ref,
  children: [],
});
const parent = object({
  key: { level: 1, x: 0, z: 0 },
  data: dummy.ref,
  height: dummy.ref,
  children: [{ key: { level: 0, x: 0, z: 0 }, index: child.ref }],
});
const root = {
  kind: "surface-lod",
  format_version: 1,
  name: "Synthetic source",
  bounds: [0, 0, 256, 256],
  spawn: [64, 64, 64],
  source_sha256: "a".repeat(64),
  generation: "source-test",
  world_id: "source-test",
  revision: 1,
  appearance_version: "1",
  height_range: [1024, 1024],
  atlas: { ...dummy.ref, url: `objects/${dummy.ref.sha256}.png` },
  material_count: 1,
  catalog: [{ ...dummy.ref, start: 0, count: 1 }],
  roots: [{ key: { level: 1, x: 0, z: 0 }, index: parent.ref }],
};

test("hierarchy walks only requested ancestors and reuses verified cached indexes", async ({
  page,
}) => {
  const requested: string[] = [];
  await page.route("**/source-harness", (r) =>
    r.fulfill({ contentType: "text/html", body: "<title>Source test</title>" }),
  );
  await page.route("**/source-test/lod.json", (r) =>
    r.fulfill({ json: root, headers: { ETag: '"one"' } }),
  );
  await page.route("**/source-test/objects/*", (r) => {
    const name = new URL(r.request().url()).pathname.split("/").at(-1)!;
    requested.push(name);
    const data = [parent, child, dummy].find((o) => o.ref.url.endsWith(name));
    return data
      ? r.fulfill({ body: data.body, contentType: "application/json" })
      : r.fulfill({ status: 404 });
  });
  await page.goto("/source-harness");
  const result = await page.evaluate(async () => {
    const { clearObjectCache } = await import("/src/object-cache.ts" as string);
    await clearObjectCache();
    const { PyramidSource } = await import("/src/lod/source.ts" as string);
    const source = new PyramidSource("/source-test/lod.json");
    const change = await source.refresh();
    const node = await source.at({ level: 0, x: 0, z: 0 });
    const same = await source.at({ level: 0, x: 0, z: 0 });
    const absent = await source.at({ level: 0, x: 1, z: 1 });
    const unchanged = await source.refresh();
    return {
      change,
      key: node.key,
      same: node === same,
      absent,
      unchanged,
      metadata: source.metadataBytes,
    };
  });
  expect(result).toMatchObject({
    change: "generation",
    key: { level: 0, x: 0, z: 0 },
    same: true,
    absent: null,
    unchanged: "unchanged",
  });
  expect(result.metadata).toBeLessThan(4096);
  expect(requested).toEqual([
    parent.ref.url.split("/").at(-1),
    child.ref.url.split("/").at(-1),
  ]);
});

test("reordered publications and changed content at the same revision are rejected", async ({
  page,
}) => {
  let current = { ...root };
  await page.route("**/source-harness", (r) =>
    r.fulfill({ contentType: "text/html", body: "<title>Source test</title>" }),
  );
  await page.route("**/source-test/lod.json", (r) =>
    r.fulfill({ json: current }),
  );
  await page.goto("/source-harness");
  await page.evaluate(async () => {
    const { PyramidSource } = await import("/src/lod/source.ts" as string);
    const s = new PyramidSource("/source-test/lod.json");
    (window as any).source = s;
    await s.refresh();
  });
  current = { ...root, name: "changed" };
  expect(
    await page.evaluate(async () => {
      try {
        await (window as any).source.refresh();
        return "accepted";
      } catch (e) {
        return String(e);
      }
    }),
  ).toContain("without advancing");
  current = { ...root, revision: 2 };
  expect(await page.evaluate(() => (window as any).source.refresh())).toBe(
    "revision",
  );
  current = { ...root };
  expect(
    await page.evaluate(async () => {
      try {
        await (window as any).source.refresh();
        return "accepted";
      } catch (e) {
        return String(e);
      }
    }),
  ).toContain("backwards");
  current = { ...root, generation: "replacement" };
  expect(await page.evaluate(() => (window as any).source.refresh())).toBe(
    "generation",
  );
});

test("failed index reads remain failures instead of becoming absent terrain", async ({
  page,
}) => {
  await page.route("**/source-harness", (r) =>
    r.fulfill({ contentType: "text/html", body: "<title>Source test</title>" }),
  );
  await page.route("**/source-test/lod.json", (r) => r.fulfill({ json: root }));
  await page.route("**/source-test/objects/*", (r) =>
    r.fulfill({ body: "{}", contentType: "application/json" }),
  );
  await page.goto("/source-harness");
  const result = await page.evaluate(async () => {
    const { clearObjectCache } = await import("/src/object-cache.ts" as string);
    await clearObjectCache();
    const { PyramidSource } = await import("/src/lod/source.ts" as string);
    const s = new PyramidSource("/source-test/lod.json");
    await s.refresh();
    try {
      await s.at({ level: 0, x: 0, z: 0 });
      return "accepted";
    } catch (e) {
      return String(e);
    }
  });
  expect(result).not.toBe("accepted");
  expect(result).toMatch(/length|size|checksum/i);
});

function material(name: string): Material {
  return {
    key: `["synthetic:${name}",{}]`,
    name,
    texture: "synthetic_stone",
    tint: 0,
    approximate: false,
    uv: [0, 0, 0.25, 0.25],
    average: [0.5, 0.5, 0.5, 1],
  };
}

function catalogPage(materials: Material[]) {
  return { ...object(materials), count: materials.length };
}

// An unchanged full first page plus a partial last page exercises the actual
// append case: its hash changes while all existing descriptor IDs stay stable.
const stableCatalog = catalogPage(
  Array.from({ length: 256 }, (_, i) => material(`fixed_${i}`)),
);

function catalogRoot(last: ReturnType<typeof catalogPage>, revision = 1) {
  return {
    ...root,
    revision,
    material_count: stableCatalog.count + last.count,
    catalog: [
      { ...stableCatalog.ref, start: 0, count: stableCatalog.count },
      { ...last.ref, start: stableCatalog.count, count: last.count },
    ],
  };
}

async function catalogHarness(
  page: Page,
  publication: { value: ReturnType<typeof catalogRoot>; etag: string },
  bodies: Map<string, string>,
) {
  const objects: string[] = [];
  const validators: (string | undefined)[] = [];
  await page.route("**/source-harness", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: "<title>Catalog test</title>",
    }),
  );
  await page.route("**/source-test/lod.json", (r) => {
    validators.push(r.request().headers()["if-none-match"]);
    return r.fulfill({
      json: publication.value,
      headers: { ETag: publication.etag },
    });
  });
  await page.route("**/source-test/objects/*", (r) => {
    const path = new URL(r.request().url()).pathname.slice(
      "/source-test/".length,
    );
    objects.push(path);
    const body = bodies.get(path);
    return body === undefined
      ? r.fulfill({ status: 404 })
      : r.fulfill({ body, contentType: "application/json" });
  });
  await page.goto("/source-harness");
  expect(
    await page.evaluate(async () => {
      const { PyramidSource } = await import("/src/lod/source.ts" as string);
      const source = new PyramidSource("/source-test/lod.json");
      const change = await source.refresh();
      window.__sourceCatalogTest = { source, accepted: source.root };
      return change;
    }),
  ).toBe("generation");
  return { objects, validators };
}

test("appending to a partial catalog page preserves existing descriptors and is a revision", async ({
  page,
}) => {
  const existing = [material("granite"), material("stone")];
  const before = catalogPage(existing);
  const after = catalogPage([...existing, material("added")]);
  expect(after.ref.sha256).not.toBe(before.ref.sha256);
  const publication = { value: catalogRoot(before), etag: '"catalog-one"' };
  const bodies = new Map([
    [stableCatalog.ref.url, stableCatalog.body],
    [before.ref.url, before.body],
    [after.ref.url, after.body],
  ]);
  const requests = await catalogHarness(page, publication, bodies);
  publication.value = catalogRoot(after, 2);
  publication.etag = '"catalog-two"';
  expect(
    await page.evaluate(() => window.__sourceCatalogTest.source.refresh()),
  ).toBe("revision");
  expect(
    await page.evaluate(async () => {
      const { source, accepted } = window.__sourceCatalogTest;
      return {
        revision: source.root.revision,
        materials: source.root.material_count,
        previousRevision: accepted.revision,
        previousMaterials: accepted.material_count,
        page: await source.catalog(1),
      };
    }),
  ).toEqual({
    revision: 2,
    materials: 259,
    previousRevision: 1,
    previousMaterials: 258,
    page: [...existing, material("added")],
  });
  expect(requests.objects).toEqual([before.ref.url, after.ref.url]);
});

for (const field of ["color", "name"] as const) {
  test(`changing an existing catalog ${field} is an appearance change even with an unchanged atlas`, async ({
    page,
  }) => {
    const existing = [material("granite"), material("stone")];
    const edited: Material =
      field === "color"
        ? { ...existing[1], average: [0.75, 0.25, 0.5, 1] }
        : { ...existing[1], name: "Renamed Stone" };
    const before = catalogPage(existing);
    // Appending at the same time must not hide a mutation in the old prefix.
    const after = catalogPage([existing[0], edited, material("added")]);
    const publication = { value: catalogRoot(before), etag: '"catalog-one"' };
    const bodies = new Map([
      [stableCatalog.ref.url, stableCatalog.body],
      [before.ref.url, before.body],
      [after.ref.url, after.body],
    ]);
    const requests = await catalogHarness(page, publication, bodies);
    publication.value = catalogRoot(after, 2);
    publication.etag = '"catalog-two"';
    expect(
      await page.evaluate(() => window.__sourceCatalogTest.source.refresh()),
    ).toBe("appearance");
    expect(
      await page.evaluate(() => {
        const { source, accepted } = window.__sourceCatalogTest;
        return {
          revision: source.root.revision,
          sameAtlas: source.root.atlas.sha256 === accepted.atlas.sha256,
          sameVersion:
            source.root.appearance_version === accepted.appearance_version,
          sameGeneration: source.root.generation === accepted.generation,
        };
      }),
    ).toEqual({
      revision: 2,
      sameAtlas: true,
      sameVersion: true,
      sameGeneration: true,
    });
    expect(requests.objects).toEqual([before.ref.url, after.ref.url]);
  });
}

test("a new catalog hash mismatch preserves the accepted root, signature and ETag", async ({
  page,
}) => {
  const existing = [material("granite"), material("stone")];
  const before = catalogPage(existing);
  const after = catalogPage([...existing, material("added")]);
  // A valid descriptor array of exactly the declared length, but wrong digest:
  // this must fail integrity validation, not JSON/schema/size validation.
  const corrupt = after.body.replace('"name":"added"', '"name":"wrong"');
  expect(Buffer.byteLength(corrupt)).toBe(after.ref.bytes);
  expect(createHash("sha256").update(corrupt).digest("hex")).not.toBe(
    after.ref.sha256,
  );
  const publication = { value: catalogRoot(before), etag: '"catalog-one"' };
  const bodies = new Map([
    [stableCatalog.ref.url, stableCatalog.body],
    [before.ref.url, before.body],
    [after.ref.url, corrupt],
  ]);
  const requests = await catalogHarness(page, publication, bodies);
  publication.value = catalogRoot(after, 2);
  publication.etag = '"catalog-two"';
  expect(
    await page.evaluate(async () => {
      try {
        await window.__sourceCatalogTest.source.refresh();
        return "accepted";
      } catch (error) {
        return String(error);
      }
    }),
  ).toMatch(/SHA-256|checksum/);
  expect(
    await page.evaluate(() => {
      const { source, accepted } = window.__sourceCatalogTest;
      return {
        sameRoot: source.root === accepted,
        revision: source.root.revision,
        materials: source.root.material_count,
      };
    }),
  ).toEqual({ sameRoot: true, revision: 1, materials: 258 });

  publication.value = catalogRoot(before);
  publication.etag = '"catalog-one"';
  expect(
    await page.evaluate(() => window.__sourceCatalogTest.source.refresh()),
  ).toBe("unchanged");
  expect(requests.validators).toEqual([
    undefined,
    '"catalog-one"',
    '"catalog-one"',
  ]);

  bodies.set(after.ref.url, after.body);
  publication.value = catalogRoot(after, 2);
  publication.etag = '"catalog-two"';
  expect(
    await page.evaluate(() => window.__sourceCatalogTest.source.refresh()),
  ).toBe("revision");
  expect(
    await page.evaluate(() => window.__sourceCatalogTest.source.root.revision),
  ).toBe(2);
  expect(requests.objects).toEqual([
    before.ref.url,
    after.ref.url,
    after.ref.url,
  ]);
});
