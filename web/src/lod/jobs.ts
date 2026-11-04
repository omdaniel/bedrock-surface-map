export interface TileJob<T> {
  id: string;
  priority: number;
  run: (signal: AbortSignal) => Promise<T>;
  complete: (result: T) => void;
  failed: (error: unknown) => void;
}

/** Bounded foreground-first work. Obsolete completions are discarded even
 * when a native decoder cannot interrupt its current bounded call.
 */
export class TileJobs<T> {
  private pending = new Map<string, TileJob<T>>();
  private active = new Map<
    string,
    { controller: AbortController; job: TileJob<T>; epoch: number }
  >();
  private wanted = new Set<string>();
  private epoch = 0;
  private disposed = false;
  readonly concurrency: number;
  readonly maxPending: number;
  constructor(concurrency = 2, maxPending = 256) {
    if (
      !Number.isInteger(concurrency) ||
      concurrency < 1 ||
      concurrency > 4 ||
      !Number.isInteger(maxPending) ||
      maxPending < concurrency ||
      maxPending > 4096
    )
      throw Error("Invalid tile job limits");
    this.concurrency = concurrency;
    this.maxPending = maxPending;
  }
  update(jobs: readonly TileJob<T>[]) {
    if (this.disposed) return;
    if (
      jobs.length > this.maxPending ||
      new Set(jobs.map((j) => j.id)).size !== jobs.length ||
      jobs.some((j) => !j.id || !Number.isFinite(j.priority))
    )
      throw Error("Invalid tile job demand");
    const epoch = ++this.epoch;
    this.wanted = new Set(jobs.map((j) => j.id));
    this.pending.clear();
    for (const [id, entry] of this.active) {
      if (!this.wanted.has(id))
        entry.controller.abort(
          new DOMException("Obsolete terrain demand", "AbortError"),
        );
    }
    for (const job of jobs) {
      const running = this.active.get(job.id);
      if (running && !running.controller.signal.aborted) {
        running.epoch = epoch;
        running.job = job;
      } else this.pending.set(job.id, job);
    }
    const urgent = [...this.pending.values()].sort(
      (a, b) => a.priority - b.priority,
    );
    const speculative = [...this.active.values()]
      .filter((e) => !e.controller.signal.aborted)
      .sort((a, b) => b.job.priority - a.job.priority);
    for (let i = 0; i < Math.min(urgent.length, speculative.length); i++) {
      const entry = speculative[i];
      if (urgent[i].priority < entry.job.priority) {
        entry.controller.abort(
          new DOMException("Foreground terrain takes priority", "AbortError"),
        );
        this.pending.set(entry.job.id, entry.job);
      }
    }
    this.pump();
  }
  private pump() {
    if (this.disposed) return;
    while (this.active.size < this.concurrency && this.pending.size) {
      const job = [...this.pending.values()]
        .filter((j) => !this.active.has(j.id))
        .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))[0];
      if (!job) break;
      this.pending.delete(job.id);
      const controller = new AbortController();
      const entry = { controller, job, epoch: this.epoch };
      this.active.set(job.id, entry);
      void Promise.resolve()
        .then(() => job.run(controller.signal))
        .then((result) => {
          if (
            !this.disposed &&
            !controller.signal.aborted &&
            this.wanted.has(job.id) &&
            entry.epoch === this.epoch
          )
            entry.job.complete(result);
        })
        .catch((error) => {
          if (
            !this.disposed &&
            !controller.signal.aborted &&
            this.wanted.has(job.id) &&
            entry.epoch === this.epoch
          )
            entry.job.failed(error);
        })
        .finally(() => {
          this.active.delete(job.id);
          this.pump();
        });
    }
  }
  dispose() {
    this.disposed = true;
    this.pending.clear();
    this.wanted.clear();
    for (const { controller } of this.active.values()) controller.abort();
  }
  get size() {
    return this.pending.size + this.active.size;
  }
  get running() {
    return this.active.size;
  }
}
