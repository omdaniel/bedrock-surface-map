import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";

function object(body: string, extension = "bin") {
  const sha256 = createHash("sha256").update(body).digest("hex");
  return {
    body,
    ref: {
      sha256,
      bytes: Buffer.byteLength(body),
      url: `objects/${sha256}.${extension}`,
    },
  };
}
const atlas = object("synthetic atlas", "png");
const catalog = object("[]", "json");
const data = [object("first surface"), object("second surface")];
const height = object("synthetic heights");
const leaves = data.map((surface, x) =>
  object(
    JSON.stringify({
      key: { level: 0, x, z: 0 },
      data: surface.ref,
      height: height.ref,
      children: [],
    }),
    "json",
  ),
);
const node = object(
  JSON.stringify({
    key: { level: 1, x: 0, z: 0 },
    data: data[0].ref,
    height: height.ref,
    children: leaves.map((leaf, x) => ({
      key: { level: 0, x, z: 0 },
      index: leaf.ref,
    })),
  }),
  "json",
);
const root = {
  kind: "surface-lod",
  format_version: 1,
  name: "Local synchronization test",
  bounds: [0, 0, 256, 128],
  spawn: [16, 64, 16],
  source_sha256: "a".repeat(64),
  generation: "synthetic",
  revision: 1,
  appearance_version: "1",
  height_range: [1024, 1024],
  atlas: atlas.ref,
  material_count: 1,
  catalog: [{ ...catalog.ref, start: 0, count: 1 }],
  roots: [{ key: { level: 1, x: 0, z: 0 }, index: node.ref }],
};
const bodies = new Map(
  [atlas, catalog, ...data, height, ...leaves, node].map((o) => [
    o.ref.url,
    o.body,
  ]),
);

async function harness(
  page: Page,
  fail: () => string | undefined,
  limit?: number,
) {
  const downloads: string[] = [];
  await page.route("**/local-dataset-harness", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: "<title>Local dataset</title>",
    }),
  );
  await page.route("**/dataset/lod.json", (r) => r.fulfill({ json: root }));
  await page.route("**/dataset/objects/*", (r) => {
    const path = new URL(r.request().url()).pathname.slice("/dataset/".length);
    downloads.push(path);
    if (path === fail()) return r.fulfill({ status: 503 });
    const body = bodies.get(path);
    return body === undefined
      ? r.fulfill({ status: 404 })
      : r.fulfill({ body });
  });
  const open = async () => {
    await page.goto("/local-dataset-harness");
    await page.evaluate(async (limit) => {
      const { PyramidSource } = await import("/src/lod/source.ts" as string);
      const source = new PyramidSource("/dataset/lod.json", limit);
      (window as any).dataset = source;
      await source.refresh();
    }, limit);
  };
  await open();
  return { downloads, open };
}
async function ready(page: Page) {
  await expect
    .poll(() => page.evaluate(() => (window as any).dataset.local.state.status))
    .toBe("ready");
}

test("an interrupted whole-world download resumes committed objects across reload", async ({
  page,
}) => {
  let failed: string | undefined = data[1].ref.url;
  const wire = await harness(page, () => failed);
  await expect
    .poll(() => page.evaluate(() => (window as any).dataset.local.state.status))
    .toBe("error");
  const before = await page.evaluate(() =>
    (window as any).dataset.local.store.stats(),
  );
  expect(before.entries).toBeGreaterThan(0);
  failed = undefined;
  wire.downloads.length = 0;
  await wire.open();
  await ready(page);
  expect(wire.downloads).toEqual([data[1].ref.url]);
  expect(
    await page.evaluate(() => (window as any).dataset.local.store.stats()),
  ).toEqual({
    entries: bodies.size,
    bytes: [...bodies.values()].reduce(
      (sum, body) => sum + Buffer.byteLength(body),
      0,
    ),
  });
});

test("missing local data triggers dataset reconciliation and never returns an unverified body", async ({
  page,
}) => {
  const wire = await harness(page, () => undefined);
  await ready(page);
  wire.downloads.length = 0;
  const text = await page.evaluate(async (ref) => {
    const source = (window as any).dataset;
    await source.local.store.removeHashes([ref.sha256]);
    return new TextDecoder().decode(
      await source.object(ref, AbortSignal.timeout(5000)),
    );
  }, data[1].ref);
  expect(text).toBe(data[1].body);
  await ready(page);
  expect(wire.downloads).toEqual([data[1].ref.url]);
});

test("insufficient disk allowance remains incomplete instead of silently falling back to viewport fetches", async ({
  page,
}) => {
  const wire = await harness(page, () => undefined, 1);
  await expect
    .poll(() => page.evaluate(() => (window as any).dataset.local.state.status))
    .toBe("error");
  const state = await page.evaluate(() => (window as any).dataset.local.state);
  expect(state.error).toContain("quota");
  expect(state.objects).toBe(0);
  expect(state.revision).toBe(0);
  expect(wire.downloads).toEqual([atlas.ref.url]);
  const error = await page.evaluate(async (ref) => {
    try {
      await (window as any).dataset.object(ref);
      return "accepted";
    } catch (e) {
      return String(e);
    }
  }, data[1].ref);
  expect(error).toContain("quota");
  expect(wire.downloads).toEqual([atlas.ref.url]);
});
