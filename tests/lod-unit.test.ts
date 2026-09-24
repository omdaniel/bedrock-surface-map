import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BASELINE_MEMORY_IDS,
  CONSTRAINED_MEMORY_LIMIT_BYTES,
  HARD_HEADROOM_BYTES,
  INITIAL_MEMORY_BUDGETS,
  MEMORY_CATEGORIES,
  MEMORY_LIMIT_BYTES,
  MemoryLedger,
  RETIREMENT_RESERVE_BYTES,
  WASM_ALLOWANCE_BYTES,
} from "../web/src/lod/memory.ts";
import type { MemoryCategory } from "../web/src/lod/memory.ts";
import {
  REFINE_DEBOUNCE_MS,
  MAX_COORDINATE,
  MAX_LEVEL,
  childTiles,
  desiredLevel,
  estimateTileBytes,
  intersection,
  intersects,
  parentTile,
  rootForest,
  selectCut,
  shadowBounds,
  tileBounds,
  tileId,
  tileSpan,
  viewTargetBounds,
} from "../web/src/lod/selection.ts";
import type { Bounds, TileKey, View } from "../web/src/lod/selection.ts";

const BASELINE_CAPACITY = 0;
const GROWTH_RESERVED = 2 * WASM_ALLOWANCE_BYTES + HARD_HEADROOM_BYTES;
const BASELINE = GROWTH_RESERVED + RETIREMENT_RESERVE_BYTES;

function verifyAccounting(ledger: MemoryLedger) {
  const state = ledger.snapshot();
  assert.equal(state.capacityBytes + state.reservedBytes, state.totalBytes);
  assert.equal(
    Object.values(state.categories).reduce((a, b) => a + b, 0),
    state.totalBytes,
  );
  assert.equal(
    state.entries.reduce((a, b) => a + b.totalBytes, 0),
    state.totalBytes,
  );
  assert.equal(state.freeBytes + state.totalBytes, state.limitBytes);
  assert.ok(state.totalBytes <= state.limitBytes);
  assert.ok(
    state.peakBytes >= state.totalBytes && state.peakBytes <= state.limitBytes,
  );
  assert.equal(
    new Set(state.entries.map((entry) => entry.id)).size,
    state.entries.length,
  );
  for (const entry of state.entries) {
    assert.equal(entry.totalBytes, entry.capacityBytes + entry.reservedBytes);
    assert.ok(entry.reservedBytes >= 0 && entry.capacityBytes >= 0);
  }
}

test("ledger defaults to 200,000,000 decimal bytes with fixed allowances and retirement reserve", () => {
  const ledger = new MemoryLedger();
  const state = ledger.snapshot();
  assert.equal(MEMORY_LIMIT_BYTES, 200_000_000);
  assert.equal(state.limitBytes, MEMORY_LIMIT_BYTES);
  assert.equal(state.totalBytes, 60_000_000);
  assert.equal(state.capacityBytes, BASELINE_CAPACITY);
  assert.equal(state.reservedBytes, BASELINE);
  assert.equal(state.freeBytes, 140_000_000);
  assert.equal(state.peakBytes, BASELINE);
  assert.equal(state.categories.wasm, 33_554_432);
  assert.equal(state.categories.headroom, 8_445_568);
  assert.equal(state.categories.retirement, RETIREMENT_RESERVE_BYTES);
  assert.equal(state.entries.length, 4);
  assert.equal(
    Object.values(INITIAL_MEMORY_BUDGETS).reduce((a, b) => a + b, 0),
    MEMORY_LIMIT_BYTES,
  );
  verifyAccounting(ledger);
});

test("GPU categories and retirement change atomically at a full memory ceiling", () => {
  const ledger = new MemoryLedger();
  const available = ledger.snapshot().freeBytes;
  assert.equal(ledger.set("gpu", "surface", available), true);
  const peak = ledger.snapshot().peakBytes;
  assert.equal(
    ledger.setCapacities([
      { id: "heights", category: "height", bytes: 20_000_000 },
      { id: "atlas", category: "atlas", bytes: 10_000_000 },
      { id: "gpu", category: "surface", bytes: available - 30_000_000 },
    ]),
    true,
  );
  verifyAccounting(ledger);
  assert.equal(ledger.snapshot().peakBytes, peak);
  assert.equal(
    ledger.setCapacities([
      { id: "retired", category: "retirement", bytes: 10_000_000 },
      { id: "atlas", category: "atlas", bytes: 0 },
    ]),
    true,
  );
  verifyAccounting(ledger);
  const before = ledger.snapshot();
  assert.equal(
    ledger.setCapacities([
      { id: "atlas", category: "atlas", bytes: 20_000_001 },
    ]),
    false,
  );
  assert.deepEqual(ledger.snapshot(), before);
  assert.throws(
    () =>
      ledger.setCapacities([
        { id: "gpu", category: "surface", bytes: 0 },
        { id: "gpu", category: "surface", bytes: 0 },
      ]),
    /Duplicate/,
  );
  assert.deepEqual(ledger.snapshot(), before);
});

test("replacement reservation borrows only protected overlap headroom and retains its charge", () => {
  const ledger = new MemoryLedger();
  assert.ok(ledger.set("resident", "surface", ledger.snapshot().freeBytes));
  assert.ok(ledger.tryReserve("resize", "retirement", 16_000_000));
  assert.equal(ledger.snapshot().totalBytes, MEMORY_LIMIT_BYTES);
  assert.equal(
    ledger.peek(BASELINE_MEMORY_IDS.retirementReserve)!.reservedBytes,
    2_000_000,
  );
  assert.equal(ledger.tryReserve("other", "retirement", 2_000_001), false);
  ledger.commit("resize", "retirement", 15_000_000);
  verifyAccounting(ledger);
  assert.equal(
    ledger.peek(BASELINE_MEMORY_IDS.retirementReserve)!.reservedBytes,
    3_000_000,
  );
  ledger.release("resize");
  assert.equal(
    ledger.peek(BASELINE_MEMORY_IDS.retirementReserve)!.reservedBytes,
    RETIREMENT_RESERVE_BYTES,
  );
  verifyAccounting(ledger);
});

test("constrained ceiling admits exactly the remaining budget and refuses one byte more", () => {
  const ledger = new MemoryLedger(CONSTRAINED_MEMORY_LIMIT_BYTES);
  assert.equal(ledger.snapshot().limitBytes, 128_000_000);
  assert.equal(ledger.tryReserve("decode", "transit", 68_000_000), true);
  assert.equal(ledger.tryReserve("overflow", "cpu", 1), false);
  assert.equal(ledger.snapshot().freeBytes, 0);
  ledger.commit("decode", "cpu", 68_000_000);
  assert.equal(ledger.snapshot().categories.transit, 0);
  assert.equal(ledger.snapshot().categories.cpu, 68_000_000);
  verifyAccounting(ledger);
});

test("category guidance is borrowable, not an allocation or an independent cap", () => {
  const ledger = new MemoryLedger();
  assert.equal(ledger.set("surface", "surface", 100_000_000), true);
  assert.equal(ledger.snapshot().categories.surface, 100_000_000);
  assert.ok(
    ledger.snapshot().categories.surface > INITIAL_MEMORY_BUDGETS.surface,
  );
  verifyAccounting(ledger);
});

test("invalid bytes and overflowing integers fail before changing state", () => {
  const ledger = new MemoryLedger();
  ledger.tryReserve("work", "cpu", 10);
  for (const bytes of [
    NaN,
    Infinity,
    -Infinity,
    -1,
    0.5,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    const before = ledger.snapshot();
    assert.throws(() => ledger.tryReserve("work", "cpu", bytes), RangeError);
    assert.throws(() => ledger.set("work", "cpu", bytes), RangeError);
    assert.throws(() => ledger.commit("work", "cpu", bytes), RangeError);
    assert.deepEqual(ledger.snapshot(), before);
  }
  const before = ledger.snapshot();
  assert.equal(
    ledger.tryReserve("work", "cpu", Number.MAX_SAFE_INTEGER),
    false,
  );
  assert.equal(ledger.set("work", "cpu", Number.MAX_SAFE_INTEGER), false);
  assert.deepEqual(ledger.snapshot(), before);
});

test("invalid limits, IDs and categories are rejected", () => {
  for (const limit of [NaN, Infinity, -1, 0.5, BASELINE - 1, 200_000_001])
    assert.throws(() => new MemoryLedger(limit), RangeError);
  const ledger = new MemoryLedger();
  assert.throws(() => ledger.tryReserve("", "cpu", 0), TypeError);
  assert.throws(() => ledger.release(""), TypeError);
  assert.throws(() => ledger.set("bad", "gpu" as MemoryCategory, 0), TypeError);
  verifyAccounting(ledger);
});

test("WASM allowances and hard headroom cannot be released or undercharged", () => {
  const ledger = new MemoryLedger();
  for (const id of Object.values(BASELINE_MEMORY_IDS)) {
    const before = ledger.snapshot();
    assert.throws(() => ledger.release(id));
    assert.throws(() => ledger.set(id, "cpu", BASELINE), RangeError);
    assert.throws(() => ledger.tryReserve(id, "wasm", 0), RangeError);
    assert.deepEqual(ledger.snapshot(), before);
  }
  assert.equal(
    ledger.tryReserve(
      BASELINE_MEMORY_IDS.mainWasm,
      "wasm",
      WASM_ALLOWANCE_BYTES + 65_536,
    ),
    true,
  );
  ledger.commit(
    BASELINE_MEMORY_IDS.mainWasm,
    "wasm",
    WASM_ALLOWANCE_BYTES + 65_536,
  );
  assert.equal(
    ledger.snapshot().categories.wasm,
    2 * WASM_ALLOWANCE_BYTES + 65_536,
  );
  verifyAccounting(ledger);
});

test("committed WASM pages are separate from reserved growth without changing total charge", () => {
  const ledger = new MemoryLedger();
  ledger.observeWasm("main", 2 * 1024 * 1024);
  ledger.observeWasm("worker", 3 * 1024 * 1024);
  const state = ledger.snapshot();
  assert.equal(state.totalBytes, BASELINE);
  assert.equal(state.capacityBytes, 5 * 1024 * 1024);
  assert.equal(state.reservedBytes, BASELINE - 5 * 1024 * 1024);
  ledger.observeWasm("main", WASM_ALLOWANCE_BYTES);
  assert.equal(ledger.peek(BASELINE_MEMORY_IDS.mainWasm)?.reservedBytes, 0);
  assert.throws(
    () => ledger.observeWasm("main", WASM_ALLOWANCE_BYTES + 65536),
    RangeError,
  );
  assert.throws(() => ledger.observeWasm("main", 0), RangeError);
  assert.throws(() => ledger.observeWasm("worker", 42), RangeError);
  verifyAccounting(ledger);
});

test("reservation commits allocated capacity and returns unused admitted bytes", () => {
  const ledger = new MemoryLedger();
  assert.equal(ledger.tryReserve("decode", "transit", 1024), true);
  assert.equal(ledger.snapshot().capacityBytes, BASELINE_CAPACITY);
  assert.equal(ledger.snapshot().reservedBytes, BASELINE + 1024);
  ledger.commit("decode", "cpu", 768);
  assert.equal(ledger.snapshot().capacityBytes, BASELINE_CAPACITY + 768);
  assert.equal(ledger.snapshot().reservedBytes, BASELINE);
  assert.equal(ledger.snapshot().peakBytes, BASELINE + 1024);
  assert.equal(ledger.snapshot().categories.transit, 0);
  assert.equal(ledger.snapshot().categories.cpu, 768);
  assert.throws(() => ledger.commit("decode", "cpu", 768), /reservation/);
  assert.throws(() => ledger.commit("missing", "cpu", 0), /reservation/);
  verifyAccounting(ledger);
});

test("commit growth needs admission and preserves the previous reservation on failure", () => {
  const ledger = new MemoryLedger();
  ledger.tryReserve("pool", "cpu", 1000);
  const before = ledger.snapshot();
  assert.throws(() => ledger.commit("pool", "cpu", 1001), /exceeds/);
  assert.deepEqual(ledger.snapshot(), before);
  assert.equal(ledger.tryReserve("pool", "cpu", 1500), true);
  ledger.commit("pool", "cpu", 1500);
  assert.equal(ledger.tryReserve("pool", "cpu", 2000), true);
  assert.equal(ledger.snapshot().capacityBytes, BASELINE_CAPACITY + 1500);
  assert.equal(ledger.snapshot().reservedBytes, BASELINE + 500);
  ledger.commit("pool", "cpu", 1900);
  assert.equal(ledger.snapshot().totalBytes, BASELINE + 1900);
  verifyAccounting(ledger);
});

test("shrinking reservation keeps resident capacity charged until commit", () => {
  const ledger = new MemoryLedger();
  ledger.set("pool", "cpu", 1000);
  ledger.tryReserve("pool", "cpu", 600);
  assert.equal(ledger.snapshot().totalBytes, BASELINE + 1000);
  assert.equal(ledger.snapshot().reservedBytes, BASELINE);
  assert.throws(() => ledger.commit("pool", "cpu", 601), /exceeds/);
  ledger.commit("pool", "cpu", 600);
  assert.equal(ledger.snapshot().totalBytes, BASELINE + 600);
  verifyAccounting(ledger);
});

test("same-ID shared pools replace atomically, including when the budget is full", () => {
  const ledger = new MemoryLedger();
  const available = ledger.snapshot().freeBytes;
  assert.equal(ledger.set("shared-pool", "surface", available), true);
  assert.equal(ledger.tryReserve("shared-pool", "surface", available), true);
  assert.equal(ledger.snapshot().totalBytes, MEMORY_LIMIT_BYTES);
  assert.equal(ledger.snapshot().reservedBytes, BASELINE);
  ledger.commit("shared-pool", "surface", available);
  assert.equal(ledger.set("shared-pool", "retirement", available), true);
  assert.equal(ledger.snapshot().categories.surface, 0);
  assert.equal(ledger.snapshot().categories.retirement, available);
  assert.equal(
    ledger.snapshot().totalBytes,
    MEMORY_LIMIT_BYTES - RETIREMENT_RESERVE_BYTES,
  );
  assert.equal(ledger.snapshot().entries.length, 5);
  verifyAccounting(ledger);
});

test("failed replacement leaves category, capacity, reservation and peak unchanged", () => {
  const ledger = new MemoryLedger();
  ledger.tryReserve("work", "transit", 100);
  ledger.set("unrelated", "atlas", ledger.snapshot().freeBytes);
  const before = ledger.snapshot();
  assert.equal(ledger.tryReserve("work", "surface", 101), false);
  assert.equal(ledger.set("work", "surface", 101), false);
  assert.deepEqual(ledger.snapshot(), before);
  ledger.commit("work", "cpu", 80);
  assert.equal(ledger.snapshot().freeBytes, 20);
  verifyAccounting(ledger);
});

test("unrelated inflight reservations survive release and resident replacement", () => {
  const ledger = new MemoryLedger();
  ledger.tryReserve("first", "transit", 400);
  ledger.tryReserve("second", "transit", 700);
  ledger.set("first", "cpu", 300);
  assert.equal(ledger.snapshot().reservedBytes, BASELINE + 700);
  ledger.release("first");
  assert.equal(ledger.snapshot().totalBytes, BASELINE + 700);
  ledger.commit("second", "surface", 650);
  assert.equal(ledger.snapshot().categories.surface, 650);
  verifyAccounting(ledger);
});

test("retiring allocations remain charged until the completion callback releases them", async () => {
  const ledger = new MemoryLedger();
  ledger.set("old-surface", "surface", 60_000_000);
  ledger.set("old-surface", "retirement", 60_000_000);
  ledger.tryReserve("new-surface", "surface", 60_000_000);
  assert.equal(ledger.tryReserve("extra", "height", 38_000_001), false);
  let complete!: () => void;
  const retirement = new Promise<void>((resolve) => {
    complete = resolve;
  }).then(() => ledger.release("old-surface"));
  await Promise.resolve();
  assert.equal(ledger.snapshot().categories.retirement, 60_000_000);
  ledger.commit("new-surface", "surface", 60_000_000);
  complete();
  await retirement;
  assert.equal(
    ledger.snapshot().categories.retirement,
    RETIREMENT_RESERVE_BYTES,
  );
  assert.equal(ledger.snapshot().categories.surface, 60_000_000);
  assert.equal(ledger.tryReserve("extra", "height", 38_000_001), true);
  verifyAccounting(ledger);
});

test("retirement uses its protected reserve at the ceiling and restores it on release", () => {
  const ledger = new MemoryLedger();
  ledger.set("ordinary", "surface", ledger.snapshot().freeBytes);
  assert.equal(ledger.set("not-retirement", "surface", 1), false);
  assert.equal(ledger.set("retired", "retirement", 10_000_000), true);
  assert.equal(ledger.snapshot().totalBytes, MEMORY_LIMIT_BYTES);
  assert.equal(
    ledger.peek(BASELINE_MEMORY_IDS.retirementReserve)?.reservedBytes,
    8_000_000,
  );
  assert.equal(
    ledger.snapshot().categories.retirement,
    RETIREMENT_RESERVE_BYTES,
  );
  assert.equal(
    ledger.set("retired", "retirement", RETIREMENT_RESERVE_BYTES),
    true,
  );
  assert.equal(
    ledger.peek(BASELINE_MEMORY_IDS.retirementReserve)?.reservedBytes,
    0,
  );
  assert.equal(
    ledger.set("retired", "retirement", RETIREMENT_RESERVE_BYTES + 1),
    false,
  );
  ledger.release("retired");
  assert.equal(ledger.snapshot().totalBytes, MEMORY_LIMIT_BYTES);
  assert.equal(
    ledger.peek(BASELINE_MEMORY_IDS.retirementReserve)?.reservedBytes,
    RETIREMENT_RESERVE_BYTES,
  );
  assert.equal(ledger.set("not-retirement", "surface", 1), false);
  verifyAccounting(ledger);
});

test("moving a live allocation into retirement does not double-charge the backing storage", () => {
  const ledger = new MemoryLedger();
  ledger.set("old", "surface", 10_000_000);
  ledger.set("other", "atlas", ledger.snapshot().freeBytes);
  assert.equal(ledger.set("old", "retirement", 10_000_000), true);
  assert.equal(ledger.snapshot().freeBytes, 10_000_000);
  assert.equal(ledger.snapshot().reservedBytes, GROWTH_RESERVED + 8_000_000);
  assert.equal(ledger.tryReserve("replacement", "surface", 10_000_000), true);
  ledger.commit("replacement", "surface", 10_000_000);
  const capacityBeforeRelease = ledger.snapshot().capacityBytes;
  ledger.release("old");
  assert.equal(
    ledger.snapshot().capacityBytes,
    capacityBeforeRelease - 10_000_000,
  );
  assert.equal(ledger.snapshot().reservedBytes, BASELINE);
  assert.equal(ledger.snapshot().totalBytes, MEMORY_LIMIT_BYTES);
  verifyAccounting(ledger);
});

test("reclassifying retirement must admit the restored reserve atomically", () => {
  const ledger = new MemoryLedger();
  ledger.set("ordinary", "surface", ledger.snapshot().freeBytes);
  ledger.set("retired", "retirement", RETIREMENT_RESERVE_BYTES);
  assert.equal(
    ledger.tryReserve("retired", "retirement", RETIREMENT_RESERVE_BYTES),
    true,
  );
  const before = ledger.snapshot();
  assert.equal(
    ledger.set("retired", "surface", RETIREMENT_RESERVE_BYTES),
    false,
  );
  assert.equal(
    ledger.tryReserve("retired", "surface", RETIREMENT_RESERVE_BYTES),
    false,
  );
  assert.throws(
    () => ledger.commit("retired", "surface", RETIREMENT_RESERVE_BYTES),
    /budget/,
  );
  assert.deepEqual(ledger.snapshot(), before);
  verifyAccounting(ledger);
});

test("retirement beyond the protected allowance competes for the overall ceiling", () => {
  const ledger = new MemoryLedger();
  ledger.set("retired", "retirement", RETIREMENT_RESERVE_BYTES + 4096);
  assert.equal(ledger.snapshot().totalBytes, BASELINE + 4096);
  assert.equal(ledger.snapshot().reservedBytes, GROWTH_RESERVED);
  ledger.set("retired", "retirement", 4096);
  assert.equal(ledger.snapshot().totalBytes, BASELINE);
  assert.equal(ledger.snapshot().reservedBytes, BASELINE - 4096);
  ledger.release("retired");
  assert.equal(ledger.snapshot().totalBytes, BASELINE);
  assert.equal(ledger.snapshot().peakBytes, BASELINE + 4096);
  verifyAccounting(ledger);
});

test("peek returns isolated entry data and does not create missing allocations", () => {
  const ledger = new MemoryLedger();
  assert.equal(ledger.peek("absent"), undefined);
  ledger.tryReserve("pending", "transit", 1024);
  const entry = ledger.peek("pending")!;
  assert.equal(entry.reservationBytes, 1024);
  entry.capacityBytes = 100_000_000;
  assert.equal(ledger.peek("pending")?.capacityBytes, 0);
  ledger.release("pending");
  assert.equal(ledger.peek("pending"), undefined);
  verifyAccounting(ledger);
});

test("zero-byte entries and idempotent release keep the historical peak", () => {
  const ledger = new MemoryLedger();
  assert.equal(ledger.tryReserve("empty", "cpu", 0), true);
  ledger.commit("empty", "cpu", 0);
  ledger.set("allocation", "cpu", 4096);
  ledger.release("allocation");
  const before = ledger.snapshot();
  ledger.release("allocation");
  ledger.release("missing");
  assert.deepEqual(ledger.snapshot(), before);
  ledger.release("empty");
  assert.equal(ledger.snapshot().totalBytes, BASELINE);
  assert.equal(ledger.snapshot().peakBytes, BASELINE + 4096);
  verifyAccounting(ledger);
});

test("all categories account in aggregate and snapshots cannot mutate the ledger", () => {
  const ledger = new MemoryLedger();
  for (const category of MEMORY_CATEGORIES) {
    ledger.set(`resident:${category}`, category, 1000);
    ledger.tryReserve(`pending:${category}`, category, 2000);
  }
  const before = ledger.snapshot();
  verifyAccounting(ledger);
  const snapshot = ledger.snapshot();
  snapshot.categories.cpu = 0;
  snapshot.entries[0].capacityBytes = 0;
  snapshot.entries.length = 0;
  assert.deepEqual(ledger.snapshot(), before);
});

test("tile span and IDs retain exact L16 and negative coordinate values", () => {
  assert.equal(tileSpan(0), 128);
  assert.equal(tileSpan(MAX_LEVEL), 8_388_608);
  assert.equal(tileId({ level: 5, x: -3, z: 7 }), "5/-3/7");
  assert.deepEqual(
    tileBounds({ level: 16, x: -1, z: 0 }),
    [-8_388_608, 0, 0, 8_388_608],
  );
  assert.deepEqual(
    tileBounds({ level: 0, x: 65_535, z: -65_536 }),
    [8_388_480, -8_388_608, 8_388_608, -8_388_480],
  );
});

test("floor parents preserve negative quadrants and children have compass order", () => {
  assert.deepEqual(parentTile({ level: 0, x: -3, z: -1 }), {
    level: 1,
    x: -2,
    z: -1,
  });
  const parent = { level: 3, x: -2, z: 1 };
  const children = childTiles(parent);
  assert.deepEqual(children, [
    { level: 2, x: -4, z: 2 },
    { level: 2, x: -3, z: 2 },
    { level: 2, x: -4, z: 3 },
    { level: 2, x: -3, z: 3 },
  ]);
  for (const child of children) assert.deepEqual(parentTile(child), parent);
  assert.equal(parentTile({ level: 16, x: -1, z: 0 }), null);
  assert.deepEqual(childTiles({ level: 0, x: 0, z: 0 }), []);
});

test("invalid levels and unsafe tile arithmetic are rejected", () => {
  for (const level of [-1, 0.5, 17, NaN, Infinity]) {
    assert.throws(() => tileSpan(level), RangeError);
    assert.throws(() => estimateTileBytes(level), RangeError);
  }
  for (const x of [NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER])
    assert.throws(() => tileBounds({ level: 0, x, z: 0 }), RangeError);
});

test("box intersections are half-open and preserve large and fractional coordinates", () => {
  const large = 2 ** 40;
  const a: Bounds = [large, -large, large + 128, -large + 128];
  const b: Bounds = [large + 127.5, -large, large + 256, -large + 256];
  assert.deepEqual(intersection(a, b), [
    large + 127.5,
    -large,
    large + 128,
    -large + 128,
  ]);
  assert.equal(
    intersects(a, [large + 128, -large, large + 256, -large + 128]),
    false,
  );
  assert.equal(intersects([0, 0, 0, 128], [-128, -128, 128, 128]), false);
  assert.equal(intersection([0, 0, 128, 128], [128, 128, 256, 256]), null);
  assert.throws(() => intersection([NaN, 0, 1, 1], [0, 0, 1, 1]), RangeError);
  assert.throws(() => intersection([2, 0, 1, 1], [0, 0, 1, 1]), RangeError);
});

test("root forest handles sign boundaries without a fictional origin-spanning ancestor", () => {
  assert.deepEqual(rootForest([-128, -128, 128, 128]), [
    { level: 0, x: -1, z: -1 },
    { level: 0, x: 0, z: -1 },
    { level: 0, x: -1, z: 0 },
    { level: 0, x: 0, z: 0 },
  ]);
  assert.deepEqual(rootForest([128, 128, 256, 256]), [
    { level: 0, x: 1, z: 1 },
  ]);
  assert.deepEqual(rootForest([-256, -256, -128, -128]), [
    { level: 0, x: -2, z: -2 },
  ]);
  assert.deepEqual(rootForest([128, 0, 384, 128]), [{ level: 2, x: 0, z: 0 }]);
  assert.deepEqual(rootForest([-256, -128, 128, 128]), [
    { level: 1, x: -1, z: -1 },
    { level: 1, x: 0, z: -1 },
    { level: 1, x: -1, z: 0 },
    { level: 1, x: 0, z: 0 },
  ]);
});

test("full supported coordinate range has exactly four L16 roots", () => {
  const roots = rootForest([
    -MAX_COORDINATE,
    -MAX_COORDINATE,
    MAX_COORDINATE,
    MAX_COORDINATE,
  ]);
  assert.deepEqual(roots, [
    { level: 16, x: -1, z: -1 },
    { level: 16, x: 0, z: -1 },
    { level: 16, x: -1, z: 0 },
    { level: 16, x: 0, z: 0 },
  ]);
  assert.deepEqual(
    rootForest([
      MAX_COORDINATE - 128,
      MAX_COORDINATE - 128,
      MAX_COORDINATE,
      MAX_COORDINATE,
    ]),
    [{ level: 0, x: 65_535, z: 65_535 }],
  );
  assert.deepEqual(rootForest([0, 0, 0, 128]), []);
  for (const bounds of [
    [0.5, 0, 128, 128],
    [-MAX_COORDINATE - 128, 0, 128, 128],
    [128, 0, 0, 128],
  ])
    assert.throws(() => rootForest(bounds), RangeError);
});

test("clipped integer dataset edges retain the minimal containing sign-quadrant forest", () => {
  const bounds: Bounds = [-3, -5, 257, 400];
  const roots = rootForest(bounds);
  assert.deepEqual(roots, [
    { level: 2, x: -1, z: -1 },
    { level: 2, x: 0, z: -1 },
    { level: 2, x: -1, z: 0 },
    { level: 2, x: 0, z: 0 },
  ]);
  const clippedArea = roots.reduce((area, tile) => {
    const box = intersection(tileBounds(tile), bounds)!;
    return area + (box[2] - box[0]) * (box[3] - box[1]);
  }, 0);
  assert.equal(clippedArea, 260 * 405);
  assert.deepEqual(rootForest([1, 1, 128, 128]), [{ level: 0, x: 0, z: 0 }]);
  assert.deepEqual(rootForest([-128, -128, -1, -1]), [
    { level: 0, x: -1, z: -1 },
  ]);
  assert.deepEqual(rootForest([127, 1, 129, 2]), [{ level: 1, x: 0, z: 0 }]);
  assert.deepEqual(
    rootForest([
      MAX_COORDINATE - 1,
      MAX_COORDINATE - 1,
      MAX_COORDINATE,
      MAX_COORDINATE,
    ]),
    [{ level: 0, x: 65_535, z: 65_535 }],
  );
  assert.deepEqual(
    rootForest([
      -MAX_COORDINATE,
      -MAX_COORDINATE,
      -MAX_COORDINATE + 1,
      -MAX_COORDINATE + 1,
    ]),
    [{ level: 0, x: -65_536, z: -65_536 }],
  );
});

function assertCutCoverage(cut: TileKey[], bounds: Bounds) {
  for (let z = bounds[1]; z < bounds[3]; z += 128)
    for (let x = bounds[0]; x < bounds[2]; x += 128)
      assert.equal(
        cut.filter((tile) =>
          intersects(tileBounds(tile), [x, z, x + 128, z + 128]),
        ).length,
        1,
        `coverage at ${x},${z}`,
      );
  for (let a = 0; a < cut.length; a++)
    for (let b = a + 1; b < cut.length; b++)
      assert.equal(intersects(tileBounds(cut[a]), tileBounds(cut[b])), false);
}

function assertBalancedCut(cut: TileKey[]) {
  for (let i = 0; i < cut.length; i++)
    for (let j = i + 1; j < cut.length; j++) {
      const a = tileBounds(cut[i]),
        b = tileBounds(cut[j]);
      const sharesVerticalEdge =
        (a[0] === b[2] || a[2] === b[0]) && a[1] < b[3] && b[1] < a[3];
      const sharesHorizontalEdge =
        (a[1] === b[3] || a[3] === b[1]) && a[0] < b[2] && b[0] < a[2];
      if (sharesVerticalEdge || sharesHorizontalEdge)
        assert.ok(
          Math.abs(cut[i].level - cut[j].level) <= 1,
          `unbalanced neighbors ${tileId(cut[i])} and ${tileId(cut[j])}`,
        );
    }
}

test("bounded cuts coarsen coverage without moving the requested bounds", () => {
  const bounds: Bounds = [-384, -256, 512, 384];
  const roots = rootForest(bounds);
  const input = structuredClone({ bounds, roots });
  for (const cap of [4, 5, 8, 16, 35, 100]) {
    const cut = selectCut(roots, bounds, 0, cap);
    assert.ok(cut.length <= cap);
    assertCutCoverage(cut, bounds);
    assertBalancedCut(cut);
  }
  const detailed = selectCut(roots, bounds, 0, 35);
  assert.equal(detailed.length, 35);
  assert.ok(detailed.every((tile) => tile.level === 0));
  assert.deepEqual({ bounds, roots }, input);
});

test("cut retains 2:1 neighbors when a boundary branch refines more cheaply than an adjacent branch", () => {
  const roots = rootForest([-2048, -2048, 2048, 2048]);
  const bounds: Bounds = [-1920, -1920, 1536, 1792];
  // Without balance admission, this cap places 2/2/-1 beside 4/0/0.
  const cut = selectCut(roots, bounds, 0, 12);
  assert.ok(cut.length <= 12);
  assertCutCoverage(cut, bounds);
  assertBalancedCut(cut);
  for (const cap of [4, 7, 10, 16, 20, 32, 48, 64]) {
    const result = selectCut(roots, bounds, 0, cap);
    assert.ok(result.length <= cap);
    assertCutCoverage(result, bounds);
    assertBalancedCut(result);
  }
});

test("cut descends into a tiny view at L16 within a one-tile budget", () => {
  const roots = rootForest([0, 0, MAX_COORDINATE, MAX_COORDINATE]);
  const target: Bounds = [
    MAX_COORDINATE - 128,
    MAX_COORDINATE - 128,
    MAX_COORDINATE,
    MAX_COORDINATE,
  ];
  assert.deepEqual(selectCut(roots, target, 0, 1), [
    { level: 0, x: 65_535, z: 65_535 },
  ]);
  assert.deepEqual(selectCut(roots, [-128, -128, 0, 0], 0, 0), []);
  assert.throws(
    () =>
      selectCut(
        rootForest([-128, -128, 128, 128]),
        [-128, -128, 128, 128],
        0,
        3,
      ),
    /roots/,
  );
  assert.throws(() => selectCut(roots, target, 0, NaN), RangeError);
});

test("cut rejects duplicate or overlapping roots instead of producing overlapping coverage", () => {
  const root = { level: 2, x: -1, z: -1 };
  const bounds: Bounds = [-512, -512, 0, 0];
  assert.throws(() => selectCut([root, root], bounds, 0, 16), /overlap/);
  assert.throws(
    () => selectCut([root, childTiles(root)[0]], bounds, 0, 16),
    /overlap/,
  );
  assert.throws(() => selectCut(Array(5).fill(root), bounds, 0, 16), /four/);
});

test("physical-pixel thresholds are strict, hysteretic, and clamp at hierarchy limits", () => {
  assert.equal(REFINE_DEBOUNCE_MS, 100);
  assert.equal(desiredLevel(3, 0, 16), 0);
  assert.equal(desiredLevel(100, 0, 16), 0);
  assert.equal(desiredLevel(0.375, 3, 16), 3);
  assert.equal(desiredLevel(0.375 + 0.001, 3, 16), 2);
  assert.equal(desiredLevel(0.125, 3, 16), 3);
  assert.equal(desiredLevel(0.125 - 0.001, 3, 16), 4);
  assert.equal(desiredLevel(0.01, 0, 16), 7);
  assert.equal(desiredLevel(10, 16, 16), 0);
  assert.equal(desiredLevel(Number.MIN_VALUE, 0, 16), 16);
  assert.equal(desiredLevel(0.01, 12, 4), 4);
  assert.equal(desiredLevel(0.001, 0, 0), 0);
  for (const scale of [0, -1, Infinity, NaN])
    assert.throws(() => desiredLevel(scale, 0, 16), RangeError);
  assert.throws(() => desiredLevel(1, -1, 16), RangeError);
});

test("tile resource estimates include picking/shading and fine/coarse height storage", () => {
  assert.deepEqual(estimateTileBytes(0), {
    surfaceBytes: 524_288,
    pickBytes: 131_072,
    shadeBytes: 0,
    heightBytes: 87_380,
    totalBytes: 742_740,
  });
  for (const level of [1, 2, 8, 16])
    assert.deepEqual(estimateTileBytes(level), {
      surfaceBytes: 393_216,
      pickBytes: 131_072,
      shadeBytes: 67_600,
      heightBytes: 152_916,
      totalBytes: 744_804,
    });
});

const WORLD: Bounds = [-4096, -4096, 4096, 4096];
const VIEW: View = { left: 0, top: 0, right: 128, bottom: 128 };

test("static view bounds align outward, clip to dataset, and preserve camera input", () => {
  const view = { left: -129.5, top: 1, right: 1, bottom: 128 };
  const before = { ...view };
  assert.deepEqual(viewTargetBounds(view, WORLD), [-256, 0, 128, 128]);
  assert.deepEqual(viewTargetBounds(view, WORLD, 1), [-256, 0, 256, 256]);
  assert.deepEqual(
    viewTargetBounds(
      { left: -1000, top: -1000, right: 1000, bottom: 1000 },
      [-128, -128, 384, 384],
      2,
    ),
    [-128, -128, 384, 384],
  );
  assert.equal(
    viewTargetBounds({ left: 4096, top: 0, right: 8192, bottom: 128 }, WORLD),
    null,
  );
  assert.deepEqual(view, before);
});

test("encoded height extrusion points up-sun for all NOAA cardinal bearings", () => {
  assert.deepEqual(
    shadowBounds(VIEW, WORLD, [0, 4096], 45, 0),
    [-128, -384, 256, 256],
  );
  assert.deepEqual(
    shadowBounds(VIEW, WORLD, [0, 4096], 45, 90),
    [-128, -128, 512, 256],
  );
  assert.deepEqual(
    shadowBounds(VIEW, WORLD, [0, 4096], 45, 180),
    [-128, -128, 256, 512],
  );
  assert.deepEqual(
    shadowBounds(VIEW, WORLD, [0, 4096], 45, 270),
    [-384, -128, 256, 256],
  );
  assert.deepEqual(
    shadowBounds(VIEW, WORLD, [-1024, 3072], 45, -90),
    shadowBounds(VIEW, WORLD, [0, 4096], 45, 270),
  );
  assert.deepEqual(
    shadowBounds(VIEW, WORLD, [0, 4096], 45, 450),
    shadowBounds(VIEW, WORLD, [0, 4096], 45, 90),
  );
});

test("diagonal shadow extrusion expands only toward the sun plus one neighbor margin", () => {
  assert.deepEqual(
    shadowBounds(VIEW, WORLD, [0, 4096], 45, 45),
    [-128, -384, 512, 256],
  );
  assert.deepEqual(
    shadowBounds(VIEW, WORLD, [0, 4096], 45, 225),
    [-384, -128, 256, 512],
  );
  assert.deepEqual(
    shadowBounds(VIEW, WORLD, [0, 16], 45, 90),
    [-128, -128, 384, 256],
  );
});

test("flat global height range is safe even at zero elevation", () => {
  for (const elevation of [0, 15, 45, 90])
    assert.deepEqual(
      shadowBounds(VIEW, WORLD, [1024, 1024], elevation, 17),
      [-128, -128, 256, 256],
    );
  assert.deepEqual(
    shadowBounds(VIEW, WORLD, [0, 4096], 90, 45),
    [-128, -128, 256, 256],
  );
});

test("coarse shading includes a whole-sample gutter beyond a tile-aligned footprint", () => {
  assert.deepEqual(
    shadowBounds(VIEW, WORLD, [1024, 1024], 45, 0, 512),
    [-512, -512, 640, 640],
  );
  for (const margin of [0, -1, 1.5, NaN, Infinity])
    assert.throws(
      () => shadowBounds(VIEW, WORLD, [0, 1], 45, 0, margin),
      RangeError,
    );
});

test("horizon and low-sun extrusion saturate at dataset edges without NaN or infinity", () => {
  assert.deepEqual(
    shadowBounds(VIEW, WORLD, [0, 4096], 0, 0),
    [-128, -4096, 256, 256],
  );
  assert.deepEqual(
    shadowBounds(VIEW, WORLD, [0, 4096], 0, 90),
    [-128, -128, 4096, 256],
  );
  assert.deepEqual(
    shadowBounds(VIEW, WORLD, [0, 4096], 0, 1e-11),
    [-128, -4096, 4096, 256],
  );
  assert.deepEqual(
    shadowBounds(VIEW, WORLD, [0, 4096], Number.MIN_VALUE, 45),
    [-128, -4096, 4096, 256],
  );
  assert.deepEqual(
    shadowBounds(VIEW, [-128, -128, 128, 128], [0, 4096], 15, 0),
    [-128, -128, 128, 128],
  );
  assert.equal(
    shadowBounds(
      { left: 4096, right: 8192, top: 0, bottom: 128 },
      WORLD,
      [0, 4096],
      45,
      0,
    ),
    null,
  );
});

test("shadow helper rejects invalid global heights and angles without changing inputs", () => {
  for (const range of [
    [1],
    [2, 1],
    [NaN, 1],
    [0, Infinity],
    [-Number.MAX_VALUE, Number.MAX_VALUE],
  ])
    assert.throws(() => shadowBounds(VIEW, WORLD, range, 45, 0), RangeError);
  for (const elevation of [-1, 91, Infinity, NaN])
    assert.throws(
      () => shadowBounds(VIEW, WORLD, [0, 1], elevation, 0),
      RangeError,
    );
  assert.throws(
    () => shadowBounds(VIEW, WORLD, [0, 1], 45, Infinity),
    RangeError,
  );
  assert.deepEqual(VIEW, { left: 0, top: 0, right: 128, bottom: 128 });
  assert.deepEqual(WORLD, [-4096, -4096, 4096, 4096]);
});
