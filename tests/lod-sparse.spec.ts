import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { coveringTile } from "../web/src/lod/cut.ts";
import { captureLodFailure } from "./lod-evidence";
import {
  parseManifest,
  parseNode,
  tileId,
  type TileKey,
} from "../web/src/lod/protocol.ts";

const directory = "web/public/maps/lod-sparse-small/";
test.afterEach(({ page }, info) => captureLodFailure(page, info));
const base = new URL("http://127.0.0.1/maps/lod-sparse-small/");
const manifest = parseManifest(
  JSON.parse(readFileSync(`${directory}lod.json`, "utf8")),
  base,
);
const nodes = new Map<string, ReturnType<typeof parseNode>>();
function visit(ref: (typeof manifest.roots)[number]) {
  const node = parseNode(
    JSON.parse(readFileSync(`${directory}${ref.index.url}`, "utf8")),
    ref.key,
    base,
  );
  nodes.set(tileId(node.key), node);
  node.children.forEach(visit);
}
manifest.roots.forEach(visit);

async function settle(page: Page) {
  await page.waitForTimeout(150);
  await page.waitForFunction(
    () => {
      const s = window.__map?.state(),
        l = s?.lod;
      return (
        window.__map?.ready &&
        l?.firstVisible !== null &&
        l?.cut.length &&
        !l.pending &&
        !l.queuedUpload &&
        !l.preparations &&
        !l.gpuPending &&
        !l.retiringBytes &&
        !s?.renderPending
      );
    },
    undefined,
    { timeout: 30_000 },
  );
  const s = await page.evaluate(() => window.__map.state());
  expect(s.lod!.failures).toEqual([]);
  expect(s.lod!.memory.peakBytes).toBeLessThanOrEqual(200_000_000);
  return s;
}

test("sparse off-view gutters use certified absence without blocking known fine terrain", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto("/?lod=/maps/lod-sparse-small/lod.json&players=off");
  await page.waitForFunction(() => window.__map?.ready);
  const projected = new Set<string>();
  for (const [x, z] of [
    [-320, 288],
    [-320, 352],
    [-64, -224],
  ]) {
    await page.evaluate(
      ({ x, z }) => {
        const s = window.__map.state();
        window.__map.pan(x - s.cx, z - s.cz);
        window.__map.zoom(6 / window.__map.state().scale);
      },
      { x, z },
    );
    const s = await settle(page);
    expect(s.cx).toBe(x);
    expect(s.cz).toBe(z);
    const cut: TileKey[] = s.lod!.cut.map((id) => {
      const [level, x, z] = id.split("/").map(Number);
      return { level, x, z };
    });
    expect(coveringTile(cut, x, z)?.level).toBe(0);
    for (const tile of s.lod!.projectedTiles) {
      const source = nodes.get(tile.source);
      expect(source).toBeDefined();
      expect(source!.children).toEqual([]);
      expect(source!.key.level).toBeGreaterThan(Number(tile.key.split("/")[0]));
      expect(nodes.has(tile.key)).toBe(false);
      projected.add(tile.key);
    }
  }
  expect(
    projected.size,
    "Exercise a real missing descendant gutter, not only existing unknown tiles",
  ).toBeGreaterThan(0);
  const before = await page.evaluate(() => window.__map.state());
  await page.waitForTimeout(500);
  expect((await page.evaluate(() => window.__map.state())).draws).toBe(
    before.draws,
  );
  expect(errors).toEqual([]);
  const clip = await page.locator("#map").boundingBox();
  expect(clip).not.toBeNull();
  const pngBytes = await page.screenshot({ clip: clip!, timeout: 15_000 });
  const png = PNG.sync.read(pngBytes),
    colors = new Set<string>();
  for (let y = 0; y < png.height; y += 13)
    for (let x = 0; x < png.width; x += 13) {
      const i = (y * png.width + x) * 4;
      colors.add(
        `${png.data[i] >> 4},${png.data[i + 1] >> 4},${png.data[i + 2] >> 4}`,
      );
    }
  expect(colors.size).toBeGreaterThan(8);
  await info.attach("sparse-fine-gutters", {
    body: pngBytes,
    contentType: "image/png",
  });
});
