import assert from "node:assert/strict";
import { test } from "node:test";
import {
  balancedCut,
  coveringTile,
  cutAncestors,
  residentCut,
  type ResidentCutOptions,
} from "../web/src/lod/cut.ts";
import {
  childTiles,
  rootForest,
  tileBounds,
  tileId,
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

function verify(keys: TileKey[], expectedArea: number | null = 1024 * 1024) {
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
  if (expectedArea !== null) assert.equal(area, expectedArea);
}

function resident(options: Partial<ResidentCutOptions> = {}) {
  return residentCut({
    roots: rootForest(bounds),
    bounds,
    focus: [400, 400],
    maxTiles: 64,
    targetLevel: 0,
    children: childTiles,
    isReady: () => true,
    ...options,
  });
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

test("picking uses the selected cut with half-open negative boundaries", () => {
  const coarse = { level: 1, x: -1, z: -1 };
  const fine = { level: 0, x: 0, z: -1 };
  const selected = [coarse, fine];
  assert.equal(coveringTile(selected, -0.25, -0.25), coarse);
  assert.equal(coveringTile(selected, -256, -256), coarse);
  assert.equal(coveringTile(selected, 0, -0.25), fine);
  assert.equal(coveringTile(selected, 128, -0.25), undefined);
  assert.equal(coveringTile(selected, -0.25, 0), undefined);
  assert.equal(coveringTile(selected, Number.NaN, 0), undefined);
  assert.equal(coveringTile([], -1, -1), undefined);
});

test("active and retiring cuts retain their shared parent caches exactly once", () => {
  assert.deepEqual(
    [
      ...cutAncestors(
        [
          { level: 0, x: -3, z: -1 },
          { level: 0, x: -4, z: -2 },
        ],
        2,
      ),
    ],
    ["0/-3/-1", "1/-2/-1", "2/-1/-1", "0/-4/-2"],
  );
  assert.equal(cutAncestors(cut(64), 2).size, 84);
  assert.equal(cutAncestors([], 16).size, 0);
  assert.throws(() => cutAncestors([], 17));
  assert.throws(() => cutAncestors([{ level: 2, x: 0, z: 0 }], 1));
});

test("resident cuts use ready fine coverage through evicted intermediate surfaces", () => {
  const isReady = (key: TileKey) => key.level !== 1;
  const keys = resident({ isReady });
  assert.equal(keys.length, 64);
  assert.ok(keys.every((key) => key.level === 0 && isReady(key)));
  verify(keys);
  const constrained = resident({ isReady, maxTiles: 16 });
  assert.ok(constrained.every(isReady));
  assert.deepEqual(constrained, rootForest(bounds));
  verify(constrained);
});

test("resident cuts honor capacity, prefer the focus and are independent of metadata ordering", () => {
  for (const maxTiles of [4, 7, 10, 16, 31, 64, 128]) {
    const keys = resident({ maxTiles });
    assert.ok(keys.length <= maxTiles);
    verify(keys);
    assert.deepEqual(
      resident({
        maxTiles,
        roots: rootForest(bounds).reverse(),
        children: (key) => childTiles(key).reverse(),
      }),
      keys,
    );
  }
  assert.equal(
    resident({ maxTiles: 7 }).filter(
      (key) => key.level === 1 && key.x >= 0 && key.z >= 0,
    ).length,
    4,
  );
  assert.equal(
    resident({ maxTiles: 7, focus: [-400, -400] }).filter(
      (key) => key.level === 1 && key.x < 0 && key.z < 0,
    ).length,
    4,
  );
});

test("a missing sibling retains its local ready parent without discarding healthy branches", () => {
  const local: [number, number, number, number] = [0, 0, 512, 512];
  const isReady = (key: TileKey) => tileId(key) !== "0/1/1";
  const keys = resident({ roots: rootForest(local), bounds: local, isReady });
  assert.equal(keys.length, 13);
  assert.ok(keys.every(isReady));
  assert.ok(keys.some((key) => tileId(key) === "1/0/0"));
  assert.ok(!keys.some((key) => key.level === 0 && key.x < 2 && key.z < 2));
  verify(keys, 512 * 512);
  assert.deepEqual(
    resident({
      roots: rootForest(local),
      bounds: local,
      isReady: (key) => isReady(key) && tileId(key) !== "1/0/0",
    }),
    rootForest(local),
  );
});

test("expanding the camera beyond a ready descendant patch falls back without holes", () => {
  const local: [number, number, number, number] = [0, 0, 512, 512];
  const roots = rootForest(local);
  const options = {
    roots,
    isReady: (key: TileKey) =>
      key.level === 2 || (key.level === 0 && key.x < 2 && key.z < 2),
    children: (key: TileKey) =>
      key.level === 2 || tileId(key) === "1/0/0" ? childTiles(key) : undefined,
  };
  const near = resident({ ...options, bounds: [3, 5, 200, 201] });
  assert.equal(near.length, 4);
  assert.ok(near.every((key) => key.level === 0));
  verify(near, 256 * 256);
  const expanded = resident({ ...options, bounds: local });
  assert.deepEqual(expanded, roots);
  verify(expanded, 512 * 512);
  assert.deepEqual(
    resident({ ...options, bounds: [1024, 1024, 2048, 2048] }),
    [],
  );
});

test("sparse metadata omits absent children but retains terminal summary coverage", () => {
  const root = { level: 2, x: 0, z: 0 };
  const [northWest, , southWest, southEast] = childTiles(root);
  const sparse = new Map<string, TileKey[]>([
    [tileId(root), [northWest, southWest, southEast]],
    [tileId(northWest), [childTiles(northWest)[0], childTiles(northWest)[3]]],
    [tileId(southWest), []],
    [tileId(southEast), [childTiles(southEast)[0], childTiles(southEast)[3]]],
  ]);
  const options = {
    roots: [root],
    bounds: tileBounds(root),
    children: (key: TileKey) => sparse.get(tileId(key)),
    isReady: (key: TileKey) =>
      key.level !== 1 || tileId(key) === tileId(southWest),
  };
  const keys = resident(options);
  assert.deepEqual(keys.map(tileId), [
    "1/0/1",
    "0/0/0",
    "0/1/1",
    "0/2/2",
    "0/3/3",
  ]);
  verify(keys, 4 * 128 * 128 + 256 * 256);
  const unreadyTerminal = {
    ...options,
    isReady: (key: TileKey) => key.level !== 1,
  };
  assert.deepEqual(resident(unreadyTerminal), [root]);
  sparse.delete(tileId(southWest));
  assert.deepEqual(resident(options), keys);
  assert.deepEqual(resident(unreadyTerminal), [root]);
  assert.deepEqual(resident({ ...options, children: () => [] }), [root]);
  assert.deepEqual(resident({ ...options, children: () => undefined }), [root]);
});

test("corner-only neighbors coarsen to their closest ready parent", () => {
  const root = { level: 3, x: 0, z: 0 };
  const [northWest, , , southEast] = childTiles(root);
  const keys = resident({
    roots: [root],
    bounds: tileBounds(root),
    children: (key) =>
      key.level === 3
        ? [northWest, southEast]
        : tileId(key) === tileId(southEast)
          ? undefined
          : childTiles(key),
  });
  assert.equal(keys.length, 14);
  assert.ok(keys.some((key) => tileId(key) === "1/1/1"));
  assert.ok(keys.some((key) => tileId(key) === "2/1/1"));
  assert.ok(keys.some((key) => key.level === 0));
  verify(keys, 2 * 512 * 512);
});

test("budget repair skips evicted parents but keeps the closest ready surface ancestor", () => {
  const root = { level: 3, x: 0, z: 0 };
  const keys = resident({
    roots: [root],
    bounds: tileBounds(root),
    maxTiles: 20,
    isReady: (key) => key.level !== 1,
  });
  assert.deepEqual(keys, childTiles(root));
  verify(keys);
});

test("ready target-level surfaces stop descent, but missing target surfaces can use finer coverage", () => {
  const roots = rootForest(bounds);
  assert.deepEqual(resident({ targetLevel: 2 }), roots);
  assert.equal(resident({ targetLevel: 1 }).length, 16);
  const missing = resident({
    targetLevel: 1,
    isReady: (key) => key.level !== 1,
  });
  assert.equal(missing.length, 64);
  assert.ok(missing.every((key) => key.level === 0));
  verify(missing);
});

test("negative extreme views reach ready leaves without retaining an L16 surface chain", () => {
  const wide: [number, number, number, number] = [
    -8388608, -8388608, 8388608, 8388608,
  ];
  const view: [number, number, number, number] = [
    -8388500, -8388500, -8388400, -8388400,
  ];
  let visits = 0;
  const keys = resident({
    roots: rootForest(wide),
    bounds: view,
    focus: [-8388450, -8388450],
    isReady: (key) => {
      visits++;
      return key.level === 0 || key.level === 16;
    },
  });
  assert.ok(visits <= 32);
  assert.ok(keys.every((key) => key.level === 0));
  assert.equal(keys.length, 4);
  assert.ok(coveringTile(keys, view[0], view[1]));
  assert.ok(coveringTile(keys, view[2] - 1, view[3] - 1));
  verify(keys, 4 * 128 * 128);
});

test("default and explicit visit caps bound callbacks while preserving ready root coverage", () => {
  const wide: [number, number, number, number] = [
    -8388608, -8388608, 8388608, 8388608,
  ];
  for (const maxVisits of [undefined, 4, 5, 8, 16, 64, 128]) {
    const readyCalls = new Set<string>(),
      childCalls = new Set<string>();
    const keys = resident({
      roots: rootForest(wide),
      bounds: wide,
      maxVisits,
      isReady: (key) => {
        assert.ok(
          !readyCalls.has(tileId(key)),
          "readiness is sampled once per node",
        );
        readyCalls.add(tileId(key));
        return true;
      },
      children: (key) => {
        assert.ok(
          !childCalls.has(tileId(key)),
          "metadata is read once per node",
        );
        childCalls.add(tileId(key));
        return childTiles(key);
      },
    });
    assert.ok(readyCalls.size <= (maxVisits ?? 512));
    assert.ok(childCalls.size <= readyCalls.size);
    assert.ok(keys.length <= 64);
    assert.ok(keys.every((key) => readyCalls.has(tileId(key))));
    verify(keys, 16777216 ** 2);
  }
});

test("resident selection is stateless when previously missing resources become ready", () => {
  const ready = new Set(rootForest(bounds).map(tileId));
  const options = { isReady: (key: TileKey) => ready.has(tileId(key)) };
  assert.deepEqual(resident(options), rootForest(bounds));
  for (const root of rootForest(bounds))
    for (const child of childTiles(root))
      for (const leaf of childTiles(child)) ready.add(tileId(leaf));
  const keys = resident(options);
  assert.equal(keys.length, 64);
  verify(keys);
});

test("bounded sparse frontiers preserve coverage and balance across deterministic cache states", () => {
  const world: [number, number, number, number] = [-1024, -1024, 1024, 1024];
  for (let seed = 1; seed <= 80; seed++) {
    let rng = seed;
    const random = () => {
      rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
      return rng / 2 ** 32;
    };
    const roots = rootForest(world);
    const known = new Map<string, TileKey>();
    const metadata = new Map<string, TileKey[]>();
    const ready = new Set(roots.map(tileId));
    const terminalCoverage: TileKey[] = [];
    const build = (key: TileKey) => {
      const id = tileId(key);
      known.set(id, key);
      if (random() < 0.65) ready.add(id);
      if (!key.level) {
        terminalCoverage.push(key);
        return;
      }
      const children = childTiles(key).filter(() => random() < 0.8);
      if (!children.length) terminalCoverage.push(key);
      if (random() < 0.85) metadata.set(id, children);
      children.forEach(build);
    };
    roots.forEach(build);
    const focus: [number, number] = [
      random() * 2400 - 1200,
      random() * 2400 - 1200,
    ];
    const radius = 128 + random() * 1200;
    const view: [number, number, number, number] =
      seed % 2
        ? world
        : [
            focus[0] - radius,
            focus[1] - radius,
            focus[0] + radius,
            focus[1] + radius,
          ];
    const maxTiles = [4, 7, 16, 40, 128][seed % 5];
    const maxVisits = [4, 9, 32, 64, 512][seed % 5];
    const select = (reverse: boolean) => {
      const visited = new Set<string>();
      const result = resident({
        roots: reverse ? [...roots].reverse() : roots,
        bounds: view,
        focus,
        maxTiles,
        maxVisits,
        targetLevel: seed % 3,
        children: (key) => {
          const children = metadata.get(tileId(key));
          return reverse ? children?.slice().reverse() : children;
        },
        isReady: (key) => {
          assert.ok(!visited.has(tileId(key)), `seed ${seed}: repeated visit`);
          visited.add(tileId(key));
          return ready.has(tileId(key));
        },
      });
      assert.ok(visited.size <= maxVisits);
      return result;
    };
    const keys = select(false);
    assert.deepEqual(select(true), keys, `seed ${seed}: nondeterministic cut`);
    assert.ok(keys.length <= maxTiles);
    assert.ok(
      keys.every((key) => ready.has(tileId(key)) && known.has(tileId(key))),
    );
    verify(keys, null);
    for (const terminal of terminalCoverage) {
      const box = tileBounds(terminal);
      const x = Math.max(box[0], view[0]),
        z = Math.max(box[1], view[1]);
      if (x < Math.min(box[2], view[2]) && z < Math.min(box[3], view[3]))
        assert.ok(
          coveringTile(keys, x, z),
          `seed ${seed}: uncovered terminal ${tileId(terminal)}`,
        );
    }
  }
});

test("invalid resident options and malformed metadata fail before selecting unsafe coverage", () => {
  for (const maxTiles of [-1, 3, 129, 4.5, Number.NaN, Infinity])
    assert.throws(() => resident({ maxTiles }), RangeError);
  for (const maxVisits of [0, 3, 4.5, Number.NaN, Infinity])
    assert.throws(() => resident({ maxVisits }), RangeError);
  for (const targetLevel of [-1, 17, 1.5, Number.NaN])
    assert.throws(() => resident({ targetLevel }), RangeError);
  assert.throws(
    () => resident({ isReady: () => false }),
    /ready visible roots/,
  );
  assert.throws(() => resident({ focus: [Number.NaN, 0] }), RangeError);
  assert.throws(() => resident({ bounds: [0, 0, -1, 0] }), RangeError);
  const root = { level: 2, x: 0, z: 0 };
  assert.throws(() => resident({ roots: [root, root] }), /overlap/);
  assert.throws(
    () => resident({ roots: [root, { level: 0, x: -1, z: 0 }] }),
    /unbalanced/,
  );
  for (const children of [
    [childTiles(root)[0], childTiles(root)[0]],
    [{ level: 1, x: -1, z: 0 }],
    [{ level: 0, x: 0, z: 0 }],
    [...childTiles(root), childTiles(root)[0]],
  ])
    assert.throws(
      () => resident({ roots: [root], children: () => children }),
      RangeError,
    );
});
