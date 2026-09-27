import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PNG } from "pngjs";
import type { LodManifest, LodNode, NodeRef } from "../web/src/lod/protocol";
import type { Material } from "../web/src/types";
import { captureLodFailure } from "./lod-evidence";

// Generate once with cargo run --locked -p surface-sync --example lod_catalog_fixture.
const directory = resolve(".local/lod-catalog-fixture");
const json = (path: string) =>
  JSON.parse(readFileSync(resolve(directory, path), "utf8"));
const roots: LodManifest[] = [0, 1, 2, 3, 4].map((stage) =>
  json(`lod-${stage}.json`),
);
const health = [0, 1, 2, 3, 4].map((stage) => json(`health-${stage}.json`));
const report: {
  probe: { x: number; z: number; height: number };
  revisions: number[];
  nodes: number;
  changed_coarse: string[];
  atlas_revisions: number[];
  atlas_changed_coarse: string[][];
} = json("report.json");
const object = (url: string) => {
  if (!/^objects\/[a-f0-9]{64}\.(json|zst|png)$/.test(url))
    throw Error(`Unexpected fixture object: ${url}`);
  return readFileSync(resolve(directory, "state", url));
};
type State = ReturnType<Window["__map"]["state"]>;
const state = (page: Page) => page.evaluate(() => window.__map.state());
const pixels = (page: Page) =>
  page.locator("#map").screenshot({
    // Capture terrain independently of the moving DOM player layer and picker.
    style:
      "#player-markers, #players-panel, #inspect { visibility: hidden !important; }",
  });
type SamplingWindow = Window & {
  __catalogAcceptance?: {
    timer: number;
    samples: number;
    maxMemory: number;
    maxLedgerPeak: number;
    revisions: number[];
  };
};
const camera = (value: State) => ({
  cx: value.cx,
  cz: value.cz,
  scale: value.scale,
  azimuth: value.azimuth,
  elevation: value.elevation,
  shadowStrength: value.shadowStrength,
  vivid: value.vivid,
  reliefStrength: value.reliefStrength,
  reliefWidth: value.reliefWidth,
});

test("native atlas replacement adopts one appearance epoch, preserves camera/picking/players, and retires on restoration", async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  const epochs: LodManifest[] = [4, 5, 6].map((stage) =>
    json(`lod-${stage}.json`),
  );
  expect(epochs.map((root) => root.revision)).toEqual(report.atlas_revisions);
  const verified = (reference: {
    url: string;
    bytes: number;
    sha256: string;
  }) => {
    const bytes = object(reference.url);
    expect(bytes.length).toBe(reference.bytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      reference.sha256,
    );
    return bytes;
  };
  const graphs = epochs.map((root) => {
    const nodes = new Map<string, LodNode>();
    const visit = (reference: NodeRef) => {
      const node: LodNode = JSON.parse(verified(reference.index).toString());
      expect(node.key).toEqual(reference.key);
      nodes.set(`${node.key.level}/${node.key.x}/${node.key.z}`, node);
      verified(node.data);
      verified(node.height);
      node.chunks?.forEach(verified);
      node.children.forEach(visit);
    };
    root.roots.forEach(visit);
    expect(nodes.size).toBe(report.nodes);
    verified(root.atlas);
    return nodes;
  });
  const catalogs = epochs.map((root) =>
    root.catalog.flatMap((catalog) => {
      const descriptors: Material[] = JSON.parse(verified(catalog).toString());
      expect(descriptors.length).toBe(catalog.count);
      return descriptors;
    }),
  );
  const pink = PNG.sync.read(object(epochs[1].atlas.url));
  expect([pink.width, pink.height]).toEqual([16, 16]);
  for (let i = 0; i < pink.data.length; i += 4)
    expect([...pink.data.subarray(i, i + 4)]).toEqual([232, 48, 176, 255]);
  for (const next of [1, 2]) {
    expect(epochs[next].atlas).not.toEqual(epochs[next - 1].atlas);
    expect(epochs[next].catalog).not.toEqual(epochs[next - 1].catalog);
    for (const field of [
      "world_id",
      "generation",
      "source_sha256",
      "appearance_version",
      "material_count",
      "bounds",
      "height_range",
    ] as const)
      expect(epochs[next][field]).toEqual(epochs[0][field]);
    expect(
      catalogs[next].map((m) => [m.key, m.name, m.uv, m.tint, m.approximate]),
    ).toEqual(
      catalogs[0].map((m) => [m.key, m.name, m.uv, m.tint, m.approximate]),
    );
    const changed: string[] = [];
    for (const [key, node] of graphs[next - 1]) {
      const newer = graphs[next].get(key)!;
      expect(newer.height).toEqual(node.height);
      if (!node.key.level) expect(newer).toEqual(node);
      else if (newer.data.url !== node.data.url) changed.push(newer.data.url);
    }
    expect(changed.sort()).toEqual(
      [...report.atlas_changed_coarse[next - 1]].sort(),
    );
    expect(changed.length).toBeGreaterThan(0);
  }
  expect(epochs[2].atlas).toEqual(epochs[0].atlas);
  expect(epochs[2].roots).toEqual(epochs[0].roots);
  expect(catalogs[2]).toEqual(catalogs[0]);
  // Every used non-sentinel average describes the replacement's actual pixels.
  for (const material of catalogs[1].slice(1))
    material.average.forEach((channel, i) =>
      expect(channel).toBeCloseTo([232 / 255, 48 / 255, 176 / 255, 1][i], 6),
    );

  const fineUrls = new Set(
    [...graphs[0].values()]
      .filter((node) => !node.key.level)
      .map((node) => node.data.url),
  );
  function gate() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release, reads: 0 };
  }
  let stage = 0,
    playerSequence = 0,
    playerX = report.probe.x + 30;
  let atlasGate = gate(),
    coarseGate = gate(),
    fineGate = gate();
  const requests: string[] = [],
    errors: string[] = [];
  let navigations = 0;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations++;
  });
  page.on("pageerror", (error) => errors.push(error.message));
  const api = "/api/v1/worlds/fixture-world/terrain";
  const player = JSON.parse(
    readFileSync("fixtures/tracking/snapshot.json", "utf8"),
  );
  await page.route("**/viewer-config.json", (route) =>
    route.fulfill({
      json: {
        terrain: {
          lod_url: `${api}/lod.json`,
          url: `${api}/manifest.json`,
          world_id: "fixture-world",
          generation: "fixture-generation",
        },
        players: {
          url: "/api/v1/worlds/fixture-world/players",
          world_id: "fixture-world",
          generation: "fixture-generation",
          source_sha256: epochs[0].source_sha256,
        },
      },
    }),
  );
  await page.route("**/api/v1/worlds/fixture-world/players", (route) => {
    const snapshot = structuredClone(player);
    snapshot.sequence = ++playerSequence;
    snapshot.sampled_at_ms = Date.now();
    snapshot.players[0].position = {
      x: playerX,
      y: 64,
      z: report.probe.z,
      heading: 90,
    };
    return route.fulfill({
      json: {
        schema_version: 1,
        world_id: "fixture-world",
        status: "live",
        reason: null,
        age_ms: 0,
        snapshot,
      },
    });
  });
  await page.route(
    "**/api/v1/worlds/fixture-world/terrain/**",
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      requests.push(path);
      if (path.endsWith("/status"))
        return route.fulfill({ json: json(`health-${stage + 4}.json`) });
      if (path.endsWith("/lod.json")) {
        const etag = `"native-atlas-${epochs[stage].revision}"`;
        return route.request().headers()["if-none-match"] === etag
          ? route.fulfill({ status: 304, headers: { ETag: etag } })
          : route.fulfill({ json: epochs[stage], headers: { ETag: etag } });
      }
      const url = `objects/${path.split("/").at(-1)}`;
      if (stage > 0) {
        const blocked =
          url === epochs[stage].atlas.url
            ? atlasGate
            : report.atlas_changed_coarse[stage - 1].includes(url)
              ? coarseGate
              : fineUrls.has(url)
                ? fineGate
                : null;
        if (blocked) {
          blocked.reads++;
          await blocked.promise;
        }
      }
      return route.fulfill({
        body: object(url),
        contentType: url.endsWith(".json")
          ? "application/json"
          : url.endsWith(".png")
            ? "image/png"
            : "application/octet-stream",
      });
    },
  );
  const evidence = [];
  try {
    await page.goto("/");
    await page.waitForFunction(() => window.__map?.ready);
    await page.evaluate(({ x, z }) => {
      const value = window.__map.state();
      window.__map.pan(x + 0.5 - value.cx, z + 0.5 - value.cz);
      window.__map.zoom(6 / window.__map.state().scale);
    }, report.probe);
    await page
      .getByRole("button", { name: "Lighting and color", exact: true })
      .click();
    await page
      .getByRole("slider", { name: "Sun elevation", exact: true })
      .evaluate((element: HTMLInputElement) => {
        element.value = "65";
        element.dispatchEvent(new Event("input", { bubbles: true }));
      });
    await page
      .getByRole("button", { name: "Lighting and color", exact: true })
      .click();
    await page.getByRole("button", { name: "Players", exact: true }).click();
    await expect(page.locator(".players-status")).toHaveText("1 online");
    const baseline = await settled(page, epochs[0].revision, 0);
    await pick(page, true);
    const baselinePixels = await pixels(page);
    await page.evaluate(() => {
      const sampling = {
        timer: 0,
        samples: 0,
        maxMemory: 0,
        maxLedgerPeak: 0,
        revisions: [] as number[],
      };
      (window as SamplingWindow).__catalogAcceptance = sampling;
      sampling.timer = window.setInterval(() => {
        const value = window.__map.state();
        sampling.samples++;
        sampling.maxMemory = Math.max(sampling.maxMemory, value.memory);
        sampling.maxLedgerPeak = Math.max(
          sampling.maxLedgerPeak,
          value.lod?.memory.peakBytes ?? 0,
        );
        const revision = value.lod?.live?.revision;
        if (revision !== undefined && sampling.revisions.at(-1) !== revision)
          sampling.revisions.push(revision);
      }, 20);
    });
    let previousPixels = baselinePixels;
    for (const next of [1, 2]) {
      atlasGate = gate();
      coarseGate = gate();
      fineGate = gate();
      const requestsBefore = requests.length;
      stage = next;
      await expect
        .poll(() => atlasGate.reads, { timeout: 30_000 })
        .toBeGreaterThan(0);
      const unavailable = await state(page);
      expect(unavailable.lod).toBeNull();
      expect(await page.evaluate(() => window.__map.ready)).toBe(false);
      expect(camera(unavailable)).toEqual(camera(baseline));
      const box = (await page.locator("#map").boundingBox())!;
      await page.mouse.move(
        box.x + box.width / 2 + 2,
        box.y + box.height / 2 + 2,
      );
      await expect(page.locator("#inspect")).toBeHidden();
      // Player polling and projection continue even while no terrain view exists.
      const playerBefore = playerSequence;
      playerX += 1;
      await expect.poll(() => playerSequence).toBeGreaterThan(playerBefore);
      await expect(page.locator(".player-detail")).toContainText(
        `${Math.floor(playerX)}, 64,`,
      );
      await expect(page.locator(".player-marker")).toHaveCount(1);
      await expect(page.locator(".player-marker")).toBeVisible();
      expect(camera(await state(page))).toEqual(camera(baseline));
      atlasGate.release();
      await expect
        .poll(() => coarseGate.reads, { timeout: 30_000 })
        .toBeGreaterThan(0);
      const loading = await state(page);
      expect(loading.lod!.live!.revision).toBe(epochs[next].revision);
      expect(loading.lod!.firstVisible).toBeNull();
      expect(loading.lod!.cut).toEqual([]);
      expect(loading.lod!.previousCut).toEqual([]);
      expect(camera(loading)).toEqual(camera(baseline));
      bounded(loading);
      coarseGate.release();
      await expect
        .poll(() => fineGate.reads, { timeout: 30_000 })
        .toBeGreaterThan(0);
      await page.waitForFunction((revision) => {
        const value = window.__map.state(),
          lod = value.lod;
        return (
          lod?.live?.revision === revision &&
          lod.firstVisible !== null &&
          lod.cut.length > 0 &&
          lod.cut.every((key) => !key.startsWith("0/")) &&
          !lod.gpuPending &&
          !value.renderPending
        );
      }, epochs[next].revision);
      const coarseOnly = await state(page);
      expect(
        coarseOnly.lod!.previousCut.every((key) => !key.startsWith("0/")),
      ).toBe(true);
      bounded(coarseOnly);
      const coarsePixels = await pixels(page);
      // The centered stone patch is green in the prior descriptor epoch and
      // pink in the new atlas epoch. Check both interim coarse and final fine.
      const appearance = (bytes: Buffer) => {
        const image = PNG.sync.read(bytes);
        const offset =
          (Math.floor(image.height / 2) * image.width +
            Math.floor(image.width / 2)) *
          4;
        const [r, g, b] = image.data.subarray(offset, offset + 3);
        if (next === 1) {
          expect(r).toBeGreaterThan(g * 1.4);
          expect(b).toBeGreaterThan(g * 1.4);
        } else expect(g).toBeGreaterThan(r * 1.4);
      };
      appearance(coarsePixels);
      await info.attach(`atlas-${next}-coarse-before-fine`, {
        body: coarsePixels,
        contentType: "image/png",
      });
      fineGate.release();
      const fine = await settled(page, epochs[next].revision, 0);
      expect(camera(fine)).toEqual(camera(baseline));
      await pick(page, true);
      const finePixels = await pixels(page);
      if (next === 1) appearance(finePixels);
      expect(pixelChanges(previousPixels, finePixels)).toBeGreaterThan(100);
      if (next === 2) expect(pixelChanges(baselinePixels, finePixels)).toBe(0);
      expect(fine.lod!.retiringBytes).toBe(0);
      expect(
        fine
          .lod!.memory.entries.filter(
            (entry) => entry.category === "retirement",
          )
          .reduce((sum, entry) => sum + entry.capacityBytes, 0),
      ).toBe(0);
      if (next === 2)
        expect(fine.lod!.memory.totalBytes).toBeLessThanOrEqual(
          baseline.lod!.memory.totalBytes + 1024 * 1024,
        );
      await expect(page.locator(".local-state")).toHaveText("Terrain live");
      const objectRequests = requests.slice(requestsBefore);
      expect(objectRequests).toContain(`${api}/${epochs[next].atlas.url}`);
      expect(objectRequests).not.toContain(
        `${api}/${epochs[next - 1].atlas.url}`,
      );
      evidence.push({
        revision: epochs[next].revision,
        atlasReads: atlasGate.reads,
        coarseReads: coarseGate.reads,
        fineReads: fineGate.reads,
        coarseCut: coarseOnly.lod!.cut,
        fineCut: fine.lod!.cut,
        peakBytes: fine.lod!.memory.peakBytes,
        memory: fine.memory,
        retiringBytes: fine.lod!.retiringBytes,
        objectRequests,
      });
      await info.attach(`atlas-${next}-fine`, {
        body: finePixels,
        contentType: "image/png",
      });
      previousPixels = finePixels;
    }
    const sampling = await page.evaluate(() => {
      const sampling = (window as SamplingWindow).__catalogAcceptance!;
      clearInterval(sampling.timer);
      return sampling;
    });
    expect(sampling.revisions).toEqual(report.atlas_revisions);
    expect(sampling.samples).toBeGreaterThan(0);
    expect(sampling.maxMemory).toBeLessThanOrEqual(200_000_000);
    expect(sampling.maxLedgerPeak).toBeLessThanOrEqual(200_000_000);
    expect(navigations).toBe(1);
    expect(errors).toEqual([]);
    await info.attach("atlas-acceptance", {
      body: JSON.stringify(
        {
          revisions: report.atlas_revisions,
          camera: camera(baseline),
          navigations,
          sampling,
          evidence,
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
  } finally {
    atlasGate.release();
    coarseGate.release();
    fineGate.release();
    await page.unrouteAll({ behavior: "wait" });
  }
});
function bounded(value: State) {
  expect(value.memory).toBeLessThanOrEqual(200_000_000);
  const lod = value.lod!;
  expect(lod.memory.peakBytes).toBeLessThanOrEqual(lod.memory.limitBytes);
  expect(lod.memory.totalBytes).toBeLessThanOrEqual(lod.memory.limitBytes);
  expect(lod.memory.limitBytes).toBeLessThanOrEqual(200_000_000);
  expect(lod.memory.totalBytes).toBe(
    lod.memory.entries.reduce((sum, entry) => sum + entry.totalBytes, 0),
  );
  expect(lod.failures).toEqual([]);
}
async function settled(page: Page, revision: number, level: number) {
  await page.waitForFunction(
    ({ revision, level }) => {
      const value = window.__map?.state(),
        lod = value?.lod;
      return Boolean(
        window.__map?.ready &&
        lod &&
        lod.live?.revision === revision &&
        lod.firstVisible !== null &&
        lod.level === level &&
        lod.cut.length &&
        !lod.pending &&
        !lod.activeKind &&
        !lod.queuedUpload &&
        !lod.preparations &&
        !lod.gpuPending &&
        !lod.retiringBytes &&
        !value.renderPending &&
        !lod.failures.length,
      );
    },
    { revision, level },
    { timeout: 60_000 },
  );
  const value = await state(page);
  bounded(value);
  return value;
}
async function pick(page: Page, approximate: boolean) {
  const box = (await page.locator("#map").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2 + 1, box.y + box.height / 2 + 1);
  await expect(page.locator("#block-name")).toHaveText("stone");
  await expect(page.locator("#block-pos")).toHaveText(
    `${report.probe.x} / ${report.probe.height.toFixed(2)} / ${report.probe.z}`,
  );
  await expect(page.locator("#block-detail")).toHaveText(
    approximate ? "Top-surface approximation" : "",
  );
}
function pixelChanges(before: Buffer, after: Buffer) {
  const a = PNG.sync.read(before),
    b = PNG.sync.read(after);
  expect([b.width, b.height]).toEqual([a.width, a.height]);
  let changed = 0,
    colored = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (
      Math.max(
        ...[0, 1, 2].map((c) => Math.abs(a.data[i + c] - b.data[i + c])),
      ) > 8
    )
      changed++;
    if (
      Math.max(b.data[i], b.data[i + 1], b.data[i + 2]) -
        Math.min(b.data[i], b.data[i + 1], b.data[i + 2]) >
      20
    )
      colored++;
  }
  expect(colored).toBeGreaterThan(20);
  return changed;
}

test.afterEach(({ page }, info) => captureLodFailure(page, info));

test("native catalog append across the page boundary and descriptor repair adopt live without reload or mixed coarse/fine appearance", async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  expect(report.revisions).toEqual(roots.map((root) => root.revision));
  expect(roots[1].roots).toEqual(roots[0].roots);
  expect(roots[1].material_count).toBe(roots[0].material_count + 1);
  expect(roots[2].material_count).toBe(roots[1].material_count);
  expect(roots[2].catalog).not.toEqual(roots[1].catalog);
  expect(roots[3].material_count).toBe(256);
  expect(
    roots[3].catalog.map(({ start, count }) => ({ start, count })),
  ).toEqual([{ start: 0, count: 256 }]);
  expect(roots[4].material_count).toBe(257);
  expect(
    roots[4].catalog.map(({ start, count }) => ({ start, count })),
  ).toEqual([
    { start: 0, count: 256 },
    { start: 256, count: 1 },
  ]);
  expect(roots[4].catalog[0]).toEqual(roots[3].catalog[0]);
  // Validate every served index/catalog hash, independently of the native audit.
  const graphs = roots.map((root) => {
    const nodes = new Map<string, LodNode>();
    const visit = (reference: NodeRef) => {
      const bytes = object(reference.index.url);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(
        reference.index.sha256,
      );
      const node: LodNode = JSON.parse(bytes.toString());
      expect(node.key).toEqual(reference.key);
      nodes.set(`${node.key.level}/${node.key.x}/${node.key.z}`, node);
      node.children.forEach(visit);
    };
    root.roots.forEach(visit);
    expect(nodes.size).toBe(report.nodes);
    for (const catalog of root.catalog) {
      const bytes = object(catalog.url);
      expect(bytes.length).toBe(catalog.bytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(
        catalog.sha256,
      );
    }
    return nodes;
  });
  for (const [key, node] of graphs[1]) {
    expect(graphs[0].get(key)).toEqual(node);
    expect(graphs[2].get(key)!.height).toEqual(node.height);
    if (!node.key.level) expect(graphs[2].get(key)).toEqual(node);
  }
  const catalogs: Material[][] = roots.map((root) => {
    const materials: Material[] = [];
    for (const page of root.catalog) {
      expect(page.start).toBe(materials.length);
      const descriptors: Material[] = JSON.parse(object(page.url).toString());
      expect(descriptors).toHaveLength(page.count);
      materials.push(...descriptors);
    }
    expect(materials).toHaveLength(root.material_count);
    expect(new Set(materials.map((material) => material.key)).size).toBe(
      materials.length,
    );
    return materials;
  });
  for (const next of [1, 3, 4])
    expect(catalogs[next].slice(0, catalogs[next - 1].length)).toEqual(
      catalogs[next - 1],
    );
  for (const next of [3, 4]) {
    expect(roots[next].roots).toEqual(roots[2].roots);
    expect(graphs[next]).toEqual(graphs[2]);
    expect(roots[next].atlas).toEqual(roots[2].atlas);
    expect(roots[next].source_sha256).toBe(roots[2].source_sha256);
    expect(roots[next].appearance_version).toBe(roots[2].appearance_version);
    expect(roots[next].revision).toBeGreaterThan(roots[next - 1].revision);
  }
  for (let id = roots[2].material_count; id < catalogs[4].length; id++) {
    expect(catalogs[4][id].name).toBe(`catalog_boundary_${id}`);
    expect(catalogs[4][id].key).toBe(
      JSON.stringify([`minecraft:catalog_boundary_${id}`, {}]),
    );
  }

  let stage = 0,
    failedRootReads = 0,
    playerSequence = 0;
  let playerX = report.probe.x + 30;
  let gateCoarse = false,
    coarseBlocked = 0;
  let releaseCoarse!: () => void;
  const coarseGate = new Promise<void>((resolve) => {
    releaseCoarse = resolve;
  });
  const requests: string[] = [],
    errors: string[] = [];
  let navigations = 0;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations++;
  });
  page.on("pageerror", (error) => errors.push(error.message));
  const api = "/api/v1/worlds/fixture-world/terrain";
  const player = JSON.parse(
    readFileSync("fixtures/tracking/snapshot.json", "utf8"),
  );
  await page.route("**/viewer-config.json", (route) =>
    route.fulfill({
      json: {
        terrain: {
          lod_url: `${api}/lod.json`,
          url: `${api}/manifest.json`,
          world_id: "fixture-world",
          generation: "fixture-generation",
        },
        players: {
          url: "/api/v1/worlds/fixture-world/players",
          world_id: "fixture-world",
          generation: "fixture-generation",
          source_sha256: roots[0].source_sha256,
        },
      },
    }),
  );
  await page.route("**/api/v1/worlds/fixture-world/players", (route) => {
    const snapshot = structuredClone(player);
    snapshot.sequence = ++playerSequence;
    snapshot.sampled_at_ms = Date.now();
    snapshot.players[0].position = {
      x: playerX,
      y: 64,
      z: report.probe.z,
      heading: 90,
    };
    return route.fulfill({
      json: {
        schema_version: 1,
        world_id: "fixture-world",
        status: "live",
        reason: null,
        age_ms: 0,
        snapshot,
      },
    });
  });
  await page.route(
    "**/api/v1/worlds/fixture-world/terrain/**",
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      requests.push(path);
      if (path.endsWith("/status"))
        return route.fulfill({ json: health[stage] });
      if (path.endsWith("/lod.json")) {
        if (stage === 2 && failedRootReads === 0) {
          failedRootReads++;
          return route.fulfill({ status: 503, body: "temporary root outage" });
        }
        const etag = `"native-catalog-${roots[stage].revision}"`;
        return route.request().headers()["if-none-match"] === etag
          ? route.fulfill({ status: 304, headers: { ETag: etag } })
          : route.fulfill({ json: roots[stage], headers: { ETag: etag } });
      }
      const url = `objects/${path.split("/").at(-1)}`;
      if (gateCoarse && report.changed_coarse.includes(url)) {
        coarseBlocked++;
        await coarseGate;
      }
      return route.fulfill({
        body: object(url),
        contentType: url.endsWith(".json")
          ? "application/json"
          : url.endsWith(".png")
            ? "image/png"
            : "application/octet-stream",
      });
    },
  );
  try {
    await page.goto("/");
    await page.waitForFunction(() => window.__map?.ready);
    await page.evaluate(({ x, z }) => {
      const value = window.__map.state();
      window.__map.pan(x + 0.5 - value.cx, z + 0.5 - value.cz);
      window.__map.zoom(6 / window.__map.state().scale);
    }, report.probe);
    await page
      .getByRole("button", { name: "Lighting and color", exact: true })
      .click();
    await page
      .getByRole("slider", { name: "Sun elevation", exact: true })
      .evaluate((element: HTMLInputElement) => {
        element.value = "65";
        element.dispatchEvent(new Event("input", { bubbles: true }));
      });
    await page
      .getByRole("button", { name: "Lighting and color", exact: true })
      .click();
    await page.getByRole("button", { name: "Players", exact: true }).click();
    await expect(page.locator(".players-status")).toHaveText("1 online");
    const baseline = await settled(page, roots[0].revision, 0);
    await page.evaluate(() => {
      const sampling = {
        timer: 0,
        samples: 0,
        maxMemory: 0,
        maxLedgerPeak: 0,
        revisions: [] as number[],
      };
      (window as SamplingWindow).__catalogAcceptance = sampling;
      sampling.timer = window.setInterval(() => {
        const value = window.__map.state();
        sampling.samples++;
        sampling.maxMemory = Math.max(sampling.maxMemory, value.memory);
        sampling.maxLedgerPeak = Math.max(
          sampling.maxLedgerPeak,
          value.lod?.memory.peakBytes ?? 0,
        );
        const revision = value.lod?.live?.revision;
        if (
          revision !== undefined &&
          sampling.revisions.at(-1) !== revision &&
          sampling.revisions.length < 32
        )
          sampling.revisions.push(revision);
      }, 20);
    });
    await pick(page, false);
    const finePixels = await pixels(page);
    const requestsBeforeAppend = requests.length;
    const playerBeforeAppend = playerSequence;
    stage = 1;
    playerX += 1;
    const appended = await settled(page, roots[1].revision, 0);
    expect(camera(appended)).toEqual(camera(baseline));
    expect(appended.lod!.tileUploads).toBe(baseline.lod!.tileUploads);
    expect(
      requests
        .slice(requestsBeforeAppend)
        .some((path) => path.endsWith(".zst")),
    ).toBe(false);
    await pick(page, false);
    expect(pixelChanges(finePixels, await pixels(page))).toBe(0);
    await expect.poll(() => playerSequence).toBeGreaterThan(playerBeforeAppend);
    await expect(page.locator(".player-detail")).toContainText(
      `${Math.floor(playerX)}, 64,`,
    );
    const draws = (await state(page)).draws;
    const playerBeforeQuiet = playerSequence;
    playerX += 1;
    await expect.poll(() => playerSequence).toBeGreaterThan(playerBeforeQuiet);
    await expect(page.locator(".player-detail")).toContainText(
      `${Math.floor(playerX)}, 64,`,
    );
    expect((await state(page)).draws).toBe(draws);
    expect(camera(await state(page))).toEqual(camera(baseline));

    await page.evaluate(() =>
      window.__map.zoom(0.12 / window.__map.state().scale),
    );
    const coarseLevel = roots[1].roots[0].key.level;
    const oldCoarse = await settled(page, roots[1].revision, coarseLevel);
    const coarsePixels = await pixels(page);
    await page.evaluate(() =>
      window.__map.zoom(6 / window.__map.state().scale),
    );
    const beforeRepair = await settled(page, roots[1].revision, 0);
    gateCoarse = true;
    stage = 2;
    await expect.poll(() => failedRootReads, { timeout: 15_000 }).toBe(1);
    await expect(page.locator(".local-state")).toHaveText("Terrain delayed");
    const delayed = await state(page);
    expect(delayed.lod!.live!.revision).toBe(roots[1].revision);
    expect(camera(delayed)).toEqual(camera(beforeRepair));
    expect(delayed.draws).toBe(beforeRepair.draws);
    await pick(page, false);
    expect(pixelChanges(finePixels, await pixels(page))).toBe(0);
    bounded(delayed);

    // Hold the new coarse colors: the reconstructed view must never expose old
    // fine picking or a visible cut under the repaired root before they arrive.
    await expect
      .poll(() => coarseBlocked, { timeout: 30_000 })
      .toBeGreaterThan(0);
    const loading = await state(page);
    expect(loading.lod!.live!.revision).toBe(roots[2].revision);
    expect(loading.lod!.firstVisible).toBeNull();
    expect(loading.lod!.cut).toEqual([]);
    expect(camera(loading)).toEqual(camera(beforeRepair));
    const box = (await page.locator("#map").boundingBox())!;
    await page.mouse.move(
      box.x + box.width / 2 + 2,
      box.y + box.height / 2 + 2,
    );
    await expect(page.locator("#inspect")).toBeHidden();
    bounded(loading);
    const playerBeforeRebuild = playerSequence;
    playerX += 1;
    await expect
      .poll(() => playerSequence)
      .toBeGreaterThan(playerBeforeRebuild);
    await expect(page.locator(".player-detail")).toContainText(
      `${Math.floor(playerX)}, 64,`,
    );
    expect(camera(await state(page))).toEqual(camera(beforeRepair));
    gateCoarse = false;
    releaseCoarse();
    const repaired = await settled(page, roots[2].revision, 0);
    expect(camera(repaired)).toEqual(camera(beforeRepair));
    await pick(page, true);
    const repairedFine = await pixels(page);
    expect(pixelChanges(finePixels, repairedFine)).toBeGreaterThan(100);
    await expect(page.locator(".local-state")).toHaveText("Terrain live");

    await page.evaluate(() =>
      window.__map.zoom(0.12 / window.__map.state().scale),
    );
    const repairedCoarse = await settled(page, roots[2].revision, coarseLevel);
    expect(camera(repairedCoarse)).toEqual(camera(oldCoarse));
    const repairedCoarsePixels = await pixels(page);
    expect(pixelChanges(coarsePixels, repairedCoarsePixels)).toBeGreaterThan(
      20,
    );
    await page.evaluate(() =>
      window.__map.zoom(6 / window.__map.state().scale),
    );
    const revisited = await settled(page, roots[2].revision, 0);
    expect(camera(revisited)).toEqual(camera(beforeRepair));
    await pick(page, true);
    expect(pixelChanges(repairedFine, await pixels(page))).toBe(0);
    const boundaryEvidence = [];
    let beforeGrowth = revisited;
    for (const next of [3, 4]) {
      const requestsBeforeGrowth = requests.length;
      const playerBeforeGrowth = playerSequence;
      stage = next;
      playerX += 1;
      const grown = await settled(page, roots[next].revision, 0);
      expect(camera(grown)).toEqual(camera(beforeGrowth));
      expect(grown.lod!.tileUploads).toBe(beforeGrowth.lod!.tileUploads);
      expect(grown.lod!.cut).toEqual(beforeGrowth.lod!.cut);
      expect(grown.lod!.firstVisible).toBe(beforeGrowth.lod!.firstVisible);
      expect(grown.lod!.heightKeys).toEqual(beforeGrowth.lod!.heightKeys);
      // Catalog comparison may read the old/new last page, but growth must
      // retain every terrain index, tile, chunk, height, and atlas already live.
      const allowedObjects = new Set(
        [...roots[next - 1].catalog, ...roots[next].catalog].map(
          (catalog) => `${api}/${catalog.url}`,
        ),
      );
      await pick(page, true);
      expect(pixelChanges(repairedFine, await pixels(page))).toBe(0);
      await expect
        .poll(() => playerSequence)
        .toBeGreaterThan(playerBeforeGrowth);
      await expect(page.locator(".player-detail")).toContainText(
        `${Math.floor(playerX)}, 64,`,
      );
      await expect(page.locator(".local-state")).toHaveText("Terrain live");
      const objectRequests = requests
        .slice(requestsBeforeGrowth)
        .filter((path) => path.includes("/objects/"));
      expect(
        objectRequests.filter((path) => !allowedObjects.has(path)),
      ).toEqual([]);
      boundaryEvidence.push({
        revision: roots[next].revision,
        materialCount: roots[next].material_count,
        catalogPages: roots[next].catalog.length,
        tileUploads: grown.lod!.tileUploads,
        peakBytes: grown.lod!.memory.peakBytes,
        objectRequests,
      });
      beforeGrowth = grown;
    }
    const sampling = await page.evaluate(() => {
      const sampling = (window as SamplingWindow).__catalogAcceptance!;
      clearInterval(sampling.timer);
      return sampling;
    });
    expect(sampling.samples).toBeGreaterThan(0);
    expect(sampling.revisions).toEqual(report.revisions);
    expect(sampling.maxMemory).toBeLessThanOrEqual(200_000_000);
    expect(sampling.maxLedgerPeak).toBeLessThanOrEqual(200_000_000);
    expect(navigations).toBe(1);
    expect(errors).toEqual([]);
    await info.attach("catalog-acceptance", {
      body: JSON.stringify(
        {
          revisions: report.revisions,
          camera: camera(revisited),
          failedRootReads,
          coarseBlocked,
          boundaryEvidence,
          navigations,
          sampling,
          peaks: [
            baseline,
            appended,
            delayed,
            repaired,
            repairedCoarse,
            revisited,
          ].map((s) => s.lod!.memory.peakBytes),
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
    await info.attach("catalog-repaired-fine", {
      body: repairedFine,
      contentType: "image/png",
    });
    await info.attach("catalog-repaired-coarse", {
      body: repairedCoarsePixels,
      contentType: "image/png",
    });
  } finally {
    releaseCoarse();
    await page.unrouteAll({ behavior: "wait" });
  }
});
