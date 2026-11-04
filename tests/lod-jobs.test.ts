import { test } from "node:test";
import assert from "node:assert/strict";
import { TileJobs, type TileJob } from "../web/src/lod/jobs.ts";
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("foreground work precedes buffer requests and concurrency is bounded", async () => {
  const starts: string[] = [],
    ends: string[] = [];
  const finish = new Map<string, () => void>();
  const jobs = new TileJobs<string>(2);
  const task = (id: string, priority: number): TileJob<string> => ({
    id,
    priority,
    run: () =>
      new Promise((resolve) => {
        starts.push(id);
        finish.set(id, () => resolve(id));
      }),
    complete: (r) => ends.push(r),
    failed: () => assert.fail("unexpected failure"),
  });
  jobs.update([task("buffer", 10), task("visible-b", 0), task("visible-a", 0)]);
  await tick();
  assert.deepEqual(starts, ["visible-a", "visible-b"]);
  assert.equal(jobs.running, 2);
  finish.get("visible-a")!();
  await tick();
  assert.deepEqual(starts, ["visible-a", "visible-b", "buffer"]);
  finish.get("visible-b")!();
  finish.get("buffer")!();
  await tick();
  assert.equal(jobs.size, 0);
  assert.equal(ends.length, 3);
});
test("obsolete completions and failures never repaint a new camera demand", async () => {
  const jobs = new TileJobs<number>(1);
  const results: number[] = [];
  let done!: (v: number) => void;
  let signal!: AbortSignal;
  jobs.update([
    {
      id: "old-hash",
      priority: 0,
      run: (s) => {
        signal = s;
        return new Promise((r) => (done = r));
      },
      complete: (v) => results.push(v),
      failed: () => assert.fail(),
    },
  ]);
  await tick();
  jobs.update([
    {
      id: "new-hash",
      priority: 0,
      run: async () => 2,
      complete: (v) => results.push(v),
      failed: () => assert.fail(),
    },
  ]);
  assert.ok(signal.aborted);
  done(1);
  await tick();
  await tick();
  assert.deepEqual(results, [2]);
});
test("continuing requests retain downloads but use the latest completion owner", async () => {
  const jobs = new TileJobs<number>(1);
  let done!: (n: number) => void;
  const results: string[] = [];
  let runs = 0;
  const make = (tag: string): TileJob<number> => ({
    id: "same-hash",
    priority: 0,
    run: () => {
      runs++;
      return new Promise((r) => (done = r));
    },
    complete: () => results.push(tag),
    failed: () => assert.fail(),
  });
  jobs.update([make("old")]);
  await tick();
  jobs.update([make("current")]);
  done(1);
  await tick();
  assert.equal(runs, 1);
  assert.deepEqual(results, ["current"]);
  jobs.dispose();
});
test("revisiting a canceled request starts fresh only after its old owner retires", async () => {
  const jobs = new TileJobs<number>(1);
  let done!: (n: number) => void;
  const values: number[] = [];
  jobs.update([
    {
      id: "a",
      priority: 1,
      run: () => new Promise((r) => (done = r)),
      complete: (v) => values.push(v),
      failed: () => assert.fail(),
    },
  ]);
  await tick();
  jobs.update([]);
  jobs.update([
    {
      id: "a",
      priority: 0,
      run: async () => 2,
      complete: (v) => values.push(v),
      failed: () => assert.fail(),
    },
  ]);
  done(1);
  await tick();
  await tick();
  assert.deepEqual(values, [2]);
  assert.throws(
    () =>
      jobs.update(
        Array.from({ length: 257 }, (_, i) => ({
          id: String(i),
          priority: 0,
          run: async () => 0,
          complete: () => {},
          failed: () => {},
        })),
      ),
    /demand/,
  );
});

test("new foreground demand preempts a still-wanted speculative download", async () => {
  const jobs = new TileJobs<string>(1);
  let aborted = false;
  const completed: string[] = [];
  const buffer: TileJob<string> = {
    id: "buffer",
    priority: 10,
    run: (signal) =>
      new Promise((resolve, reject) => {
        if (aborted) resolve("buffer");
        else
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(signal.reason);
            },
            { once: true },
          );
      }),
    complete: (value) => completed.push(value),
    failed: () => assert.fail(),
  };
  jobs.update([buffer]);
  await tick();
  jobs.update([
    buffer,
    {
      id: "visible",
      priority: 0,
      run: async () => "visible",
      complete: (v) => completed.push(v),
      failed: () => assert.fail(),
    },
  ]);
  await tick();
  await tick();
  await tick();
  assert.ok(aborted);
  assert.deepEqual(completed, ["visible", "buffer"]);
});
