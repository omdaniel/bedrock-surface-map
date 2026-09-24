export const MEMORY_LIMIT_BYTES = 200_000_000;
export const CONSTRAINED_MEMORY_LIMIT_BYTES = 128_000_000;
export const WASM_ALLOWANCE_BYTES = 16 * 1024 * 1024;
export const HARD_HEADROOM_BYTES = 8_445_568;
export const RETIREMENT_RESERVE_BYTES = 18_000_000;

export const MEMORY_CATEGORIES = [
  "wasm",
  "cpu",
  "transit",
  "atlas",
  "surface",
  "height",
  "retirement",
  "presentation",
  "headroom",
] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

// Planning guidance, not per-category limits or physical allocations.
export const INITIAL_MEMORY_BUDGETS: Readonly<Record<MemoryCategory, number>> =
  Object.freeze({
    wasm: 33_554_432,
    cpu: 12_000_000,
    transit: 8_000_000,
    atlas: 24_000_000,
    surface: 60_000_000,
    height: 24_000_000,
    retirement: RETIREMENT_RESERVE_BYTES,
    presentation: 12_000_000,
    headroom: HARD_HEADROOM_BYTES,
  });

export const BASELINE_MEMORY_IDS = Object.freeze({
  mainWasm: "wasm:main",
  workerWasm: "wasm:worker",
  headroom: "headroom",
  retirementReserve: "retirement:reserve",
});

export interface MemoryEntry {
  id: string;
  category: MemoryCategory;
  capacityBytes: number;
  /** Additional charge above the existing capacity during a reservation. */
  reservedBytes: number;
  /** Full admitted replacement capacity, or null when no work is pending. */
  reservationBytes: number | null;
  totalBytes: number;
}

export interface MemorySnapshot {
  limitBytes: number;
  capacityBytes: number;
  reservedBytes: number;
  totalBytes: number;
  freeBytes: number;
  peakBytes: number;
  categories: Record<MemoryCategory, number>;
  entries: MemoryEntry[];
}

function validateBytes(bytes: number) {
  if (!Number.isSafeInteger(bytes) || bytes < 0)
    throw new RangeError("Memory bytes must be a nonnegative safe integer");
}

/**
 * Accounts for all application-owned allocations and admitted future work.
 * Use one ID per shared backing allocation; byte counts are allocated capacity,
 * not the logical length of a view into a pool. Coexisting old/new allocations
 * need separate IDs, including resources awaiting a retirement callback.
 */
export class MemoryLedger {
  readonly limitBytes: number;
  private readonly entries = new Map<string, MemoryEntry>();
  private retirementBytes = 0;
  private totalBytes = RETIREMENT_RESERVE_BYTES;
  private peakBytes = RETIREMENT_RESERVE_BYTES;

  constructor(limitBytes = MEMORY_LIMIT_BYTES) {
    validateBytes(limitBytes);
    if (
      limitBytes <
        2 * WASM_ALLOWANCE_BYTES +
          HARD_HEADROOM_BYTES +
          RETIREMENT_RESERVE_BYTES ||
      limitBytes > MEMORY_LIMIT_BYTES
    )
      throw new RangeError(
        "Memory limit must contain the baseline and be <= 200000000",
      );
    this.limitBytes = limitBytes;
    this.tryReserve(BASELINE_MEMORY_IDS.mainWasm, "wasm", WASM_ALLOWANCE_BYTES);
    this.tryReserve(
      BASELINE_MEMORY_IDS.workerWasm,
      "wasm",
      WASM_ALLOWANCE_BYTES,
    );
    this.tryReserve(
      BASELINE_MEMORY_IDS.headroom,
      "headroom",
      HARD_HEADROOM_BYTES,
    );
  }

  /** Charge committed linear memory while retaining its nonborrowable growth allowance. */
  observeWasm(role: "main" | "worker", bytes: number): void {
    validateBytes(bytes);
    if (
      !["main", "worker"].includes(role) ||
      bytes % 65536 !== 0 ||
      bytes > WASM_ALLOWANCE_BYTES
    )
      throw new RangeError("WASM capacity exceeds its bounded page allowance");
    const id =
      role === "main"
        ? BASELINE_MEMORY_IDS.mainWasm
        : BASELINE_MEMORY_IDS.workerWasm;
    if (bytes < (this.entries.get(id)?.capacityBytes ?? 0))
      throw new RangeError(
        "Committed WASM capacity cannot shrink within one instance",
      );
    if (!this.replace(id, "wasm", bytes, WASM_ALLOWANCE_BYTES))
      throw new RangeError("WASM capacity exceeds admitted memory");
  }

  /** Admit work before allocating; replacing a reservation is atomic. */
  tryReserve(id: string, category: MemoryCategory, bytes: number): boolean {
    this.validate(id, category, bytes);
    const capacity = this.entries.get(id)?.capacityBytes ?? 0;
    return this.replace(id, category, capacity, bytes);
  }

  /** Commit allocated capacity. Growth requires an admitted reservation first. */
  commit(id: string, category: MemoryCategory, actualBytes: number): void {
    this.validate(id, category, actualBytes);
    const entry = this.entries.get(id);
    if (!entry || entry.reservationBytes === null)
      throw new Error("Memory commit requires an existing reservation");
    if (actualBytes > entry.reservationBytes)
      throw new RangeError("Memory commit exceeds its reservation");
    if (!this.replace(id, category, actualBytes, null))
      throw new RangeError(
        "Memory commit cannot restore the retirement reserve within budget",
      );
  }

  /**
   * Atomically admit/update resident capacity, or move it into retirement.
   * False leaves both the entry and any pending reservation unchanged.
   */
  set(id: string, category: MemoryCategory, bytes: number): boolean {
    this.validate(id, category, bytes);
    return this.replace(id, category, bytes, null);
  }

  /** Reclassify a shared allocation atomically, without transient double charging. */
  setCapacities(
    values: readonly { id: string; category: MemoryCategory; bytes: number }[],
  ): boolean {
    const ids = new Set<string>();
    let total = this.totalBytes - this.retirementReserve();
    let retired = this.retirementBytes;
    for (const value of values) {
      this.validate(value.id, value.category, value.bytes);
      if (ids.has(value.id)) throw new Error("Duplicate memory capacity ID");
      ids.add(value.id);
      const previous = this.entries.get(value.id);
      total += value.bytes - (previous?.totalBytes ?? 0);
      retired +=
        (value.category === "retirement" ? value.bytes : 0) -
        (previous?.category === "retirement" ? previous.capacityBytes : 0);
    }
    total += this.retirementReserve(retired);
    if (!Number.isSafeInteger(total) || total > this.limitBytes) return false;
    for (const value of values)
      this.entries.set(value.id, {
        id: value.id,
        category: value.category,
        capacityBytes: value.bytes,
        reservedBytes: 0,
        reservationBytes: null,
        totalBytes: value.bytes,
      });
    this.retirementBytes = retired;
    this.totalBytes = total;
    this.peakBytes = Math.max(this.peakBytes, total);
    return true;
  }

  /** Retirement stays charged until the owner explicitly releases its ID. */
  release(id: string): void {
    this.validateId(id);
    if (this.baseline(id) || id === BASELINE_MEMORY_IDS.retirementReserve)
      throw new Error("Cannot release protected memory allowances");
    const entry = this.entries.get(id);
    if (!entry) return;
    const previousReserve = this.retirementReserve();
    if (entry.category === "retirement")
      this.retirementBytes -= entry.capacityBytes;
    this.totalBytes +=
      this.retirementReserve() - previousReserve - entry.totalBytes;
    this.entries.delete(id);
  }

  peek(id: string): MemoryEntry | undefined {
    this.validateId(id);
    if (id === BASELINE_MEMORY_IDS.retirementReserve)
      return this.retirementEntry();
    const entry = this.entries.get(id);
    return entry ? { ...entry } : undefined;
  }

  snapshot(): MemorySnapshot {
    const categories = Object.fromEntries(
      MEMORY_CATEGORIES.map((category) => [category, 0]),
    ) as Record<MemoryCategory, number>;
    let capacityBytes = 0;
    let reservedBytes = 0;
    const entries = [...this.entries.values(), this.retirementEntry()].map(
      (entry) => {
        capacityBytes += entry.capacityBytes;
        reservedBytes += entry.reservedBytes;
        categories[entry.category] += entry.totalBytes;
        return { ...entry };
      },
    );
    return {
      limitBytes: this.limitBytes,
      capacityBytes,
      reservedBytes,
      totalBytes: this.totalBytes,
      freeBytes: this.limitBytes - this.totalBytes,
      peakBytes: this.peakBytes,
      categories,
      entries,
    };
  }

  private replace(
    id: string,
    category: MemoryCategory,
    capacityBytes: number,
    reservationBytes: number | null,
  ): boolean {
    const totalBytes = Math.max(capacityBytes, reservationBytes ?? 0);
    const previous = this.entries.get(id);
    const retirementBytes =
      this.retirementBytes -
      (previous?.category === "retirement" ? previous.capacityBytes : 0) +
      (category === "retirement" ? capacityBytes : 0);
    const otherBytes =
      this.totalBytes -
      (previous?.totalBytes ?? 0) -
      this.retirementReserve() +
      this.retirementReserve(retirementBytes);
    if (totalBytes > this.limitBytes - otherBytes) return false;
    this.entries.set(id, {
      id,
      category,
      capacityBytes,
      reservedBytes: totalBytes - capacityBytes,
      reservationBytes,
      totalBytes,
    });
    this.totalBytes = otherBytes + totalBytes;
    this.retirementBytes = retirementBytes;
    this.peakBytes = Math.max(this.peakBytes, this.totalBytes);
    return true;
  }

  private validateId(id: string) {
    if (typeof id !== "string" || id.length === 0)
      throw new TypeError("Memory entry ID must be a nonempty string");
  }

  // Retired GPU bytes are already in the resource total. Only the unoccupied
  // portion of the retirement allowance is reserved, and release restores it.
  private retirementReserve(bytes = this.retirementBytes): number {
    return Math.max(0, RETIREMENT_RESERVE_BYTES - bytes);
  }

  private retirementEntry(): MemoryEntry {
    const bytes = this.retirementReserve();
    return {
      id: BASELINE_MEMORY_IDS.retirementReserve,
      category: "retirement",
      capacityBytes: 0,
      reservedBytes: bytes,
      reservationBytes: bytes,
      totalBytes: bytes,
    };
  }

  private baseline(
    id: string,
  ): { category: MemoryCategory; bytes: number } | null {
    if (id === BASELINE_MEMORY_IDS.headroom)
      return { category: "headroom", bytes: HARD_HEADROOM_BYTES };
    if (
      id === BASELINE_MEMORY_IDS.mainWasm ||
      id === BASELINE_MEMORY_IDS.workerWasm
    )
      return { category: "wasm", bytes: WASM_ALLOWANCE_BYTES };
    return null;
  }

  private validate(id: string, category: MemoryCategory, bytes: number) {
    this.validateId(id);
    validateBytes(bytes);
    if (id === BASELINE_MEMORY_IDS.retirementReserve)
      throw new RangeError(
        "Retirement reserve is managed by charged retirement capacity",
      );
    if (!MEMORY_CATEGORIES.includes(category))
      throw new TypeError("Unknown memory category");
    const baseline = this.baseline(id);
    if (baseline && (baseline.category !== category || bytes < baseline.bytes))
      throw new RangeError(
        "Cannot reduce or reclassify a baseline memory allowance",
      );
  }
}
