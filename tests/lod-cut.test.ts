import assert from "node:assert/strict";
import { test } from "node:test";
import { balancedCut } from "../web/src/lod/cut.ts";
import {
  childTiles,
  rootForest,
  tileBounds,
  type TileKey,
} from "../web/src/lod/selection.ts";

const bounds: [number, number, number, number] = [-512, -512, 512, 512];
function cut(maxTiles: number, admit = () => true) {
  return balancedCut({
    roots: rootForest(bounds),
    bounds,
    focus: [400, 400],
    maxTiles,
    shouldRefine: (key) => key.level > 0,
    children: childTiles,
    admit,
  });
}

function verify(keys: TileKey[]) {
  let area = 0;
  for (let i = 0; i < keys.length; i++) {
    const a = tileBounds(keys[i]);
    area += (a[2] - a[0]) * (a[3] - a[1]);
    for (let j = i + 1; j < keys.length; j++) {
      const b = tileBounds(keys[j]);
      assert.ok(!(a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]));
      const adjacent =
        ((a[0] === b[2] || a[2] === b[0]) &&
          Math.max(a[1], b[1]) <= Math.min(a[3], b[3])) ||
        ((a[1] === b[3] || a[3] === b[1]) &&
          Math.max(a[0], b[0]) <= Math.min(a[2], b[2]));
      if (adjacent) assert.ok(Math.abs(keys[i].level - keys[j].level) <= 1);
    }
  }
  assert.equal(area, 1024 * 1024);
}

test("balanced cuts retain root coverage, refine siblings together and prefer the focus", () => {
  for (const capacity of [4, 7, 10, 16, 31, 64, 128]) {
    const keys = cut(capacity);
    assert.ok(keys.length <= capacity);
    verify(keys);
  }
  const first = cut(7);
  assert.equal(
    first.filter((key) => key.level === 1 && key.x >= 0 && key.z >= 0).length,
    4,
  );
});

test("unavailable or unadmitted child groups keep their covering parent", () => {
  assert.deepEqual(
    cut(64, () => false),
    rootForest(bounds),
  );
  const keys = balancedCut({
    roots: rootForest(bounds),
    bounds,
    focus: [0, 0],
    maxTiles: 64,
    shouldRefine: () => true,
    children: (key) => (key.x < 0 ? undefined : childTiles(key)),
    admit: () => true,
  });
  verify(keys);
  assert.ok(keys.some((key) => key.level === 2));
});

test("sparse children and extreme coordinates do not expand a flat world index", () => {
  let visited = 0;
  const wide: [number, number, number, number] = [
    -8388608, -8388608, 8388608, 8388608,
  ];
  const view: [number, number, number, number] = [
    -8388500, -8388500, -8388400, -8388400,
  ];
  const keys = balancedCut({
    roots: rootForest(wide),
    bounds: view,
    focus: [-8388450, -8388450],
    maxTiles: 8,
    shouldRefine: (key) => key.level > 0,
    children: (key) => {
      visited++;
      return childTiles(key);
    },
    admit: () => true,
  });
  assert.ok(visited <= 20);
  assert.ok(keys.every((key) => key.level === 0));
  assert.ok(keys.length <= 4);
});
