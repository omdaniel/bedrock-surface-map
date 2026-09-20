import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Roster,
  Publisher,
  compassHeading,
  failureCode,
  trackingInterval,
} from "../src/core.ts";
const player = () => ({
  id: "entity-private",
  name: "ExamplePlayer",
  dimension: { id: "minecraft:overworld" },
  location: { x: -2.5, y: 64, z: 8 },
  getRotation: () => ({ x: 0, y: 0 }),
});
test("100ms active sampling, coalesced events, slow ticks and empty heartbeats", async () => {
  let online = true;
  const sent: number[] = [];
  const p = new Publisher(
    "fixture",
    "instance",
    0,
    () => (online ? new Roster().sample([player()]) : []),
    async (s) => {
      sent.push(s.sampled_at_ms);
    },
    () => {},
    () => {},
  );
  await p.tick(0, 0);
  p.changed();
  await p.tick(1, 50);
  await p.tick(2, 100);
  await p.tick(3, 500); // Tick budget also applies under a slow game loop.
  await p.tick(4, 600);
  assert.deepEqual(sent, [0, 100, 600]);
  online = false;
  p.changed();
  await p.tick(6, 700);
  await p.tick(8, 800);
  await p.tick(46, 2700);
  assert.deepEqual(sent, [0, 100, 600, 700, 2700]);
  online = true;
  p.changed();
  await p.tick(48, 2800);
  assert.equal(sent.at(-1), 2800);
  assert.equal(trackingInterval(), 100);
  assert.equal(trackingInterval(500), 500);
  for (const v of [null, "100", 0, 99, 125, 2050, NaN])
    assert.throws(() => trackingInterval(v));
});
test("slow active requests never overlap or replay queued samples", async () => {
  let complete: () => void = () => {};
  let calls = 0;
  const p = new Publisher(
    "fixture",
    "instance",
    0,
    () => new Roster().sample([player()]),
    () => {
      calls++;
      return new Promise<void>((resolve) => {
        complete = resolve;
      });
    },
    () => {},
    () => {},
  );
  const first = p.tick(0, 0);
  for (let tick = 2; tick <= 20; tick += 2) await p.tick(tick, tick * 50);
  assert.equal(calls, 1);
  complete();
  await first;
  const second = p.tick(22, 1100);
  assert.equal(calls, 2);
  complete();
  await second;
});
test("game-tick cadence tolerates clock jitter and rate-limits roster events", async () => {
  const sent: number[] = [];
  const p = new Publisher(
    "fixture",
    "instance",
    0,
    () => new Roster().sample([player()]),
    async (s) => {
      sent.push(s.sampled_at_ms);
    },
    () => {},
    () => {},
  );
  for (let tick = 0; tick <= 200; tick++) {
    p.changed();
    await p.tick(tick, tick * 50 + (tick % 4 === 0 ? 1 : 0));
  }
  assert.equal(sent.length, 101);
  assert.ok(
    sent.slice(1).every((t, i) => t - sent[i] >= 99 && t - sent[i] <= 101),
  );
});
test("failure diagnostics never include credentials or raw exception details", () => {
  assert.equal(
    failureCode(new Error("secret=private-credential")),
    "sampling-or-request",
  );
  assert.equal(failureCode(new Error("HTTP_401")), "HTTP_401");
  const failure = new Error("private URL and credential");
  failure.name = "TLSOnlyError";
  assert.equal(failureCode(failure), "TLSOnlyError");
  assert.equal(failureCode({ token: "private-credential" }), "unclassified");
});
test("headings, identities, invalid reads, spawn, leave and service filtering", () => {
  assert.deepEqual(
    [-180, -90, 0, 90, 180].map(compassHeading),
    [0, 90, 180, 270, 0],
  );
  const roster = new Roster(["FixtureObserver"]),
    p = player();
  const first = roster.sample([p]);
  assert.equal(first[0].position?.x, -2.5);
  assert.equal(first[0].position?.heading, 180);
  assert.notEqual(first[0].id, p.id);
  assert.equal(first[0].discontinuity, true);
  roster.acknowledge();
  assert.equal(roster.sample([p])[0].discontinuity, false);
  roster.spawn(p.id);
  assert.equal(roster.sample([p])[0].discontinuity, true);
  const broken = {
    ...p,
    getRotation: () => {
      throw Error("gone");
    },
  };
  assert.equal(roster.sample([broken])[0].position, null);
  assert.deepEqual(roster.sample([{ ...p, name: "fixtureobserver" }]), []);
  assert.equal(
    new Roster().sample([{ ...p, name: "FixtureObserver" }]).length,
    1,
  );
  for (const invalid of [
    "name",
    [null],
    [""],
    ["bad\nname"],
    Array(33).fill("name"),
  ])
    assert.throws(() => new Roster(invalid));
  roster.leave(p.id);
  assert.notEqual(roster.sample([p])[0].id, first[0].id);
  assert.throws(() => roster.sample(Array.from({ length: 33 }, player)));
});
test("one in flight, bounded retry and fresh samples on recovery", async () => {
  let reads = 0,
    acks = 0,
    warnings = 0,
    fail = true,
    release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const snapshots: number[] = [];
  const publisher = new Publisher(
    "fixture",
    "instance",
    1000,
    () => {
      reads++;
      return [];
    },
    async (s) => {
      snapshots.push(s.sampled_at_ms);
      await pending;
      if (fail) throw Error("offline");
    },
    () => {
      acks++;
    },
    () => {
      warnings++;
    },
  );
  const first = publisher.tick(0, 1000);
  await publisher.tick(40, 3000);
  assert.equal(reads, 1);
  release!();
  await first;
  assert.equal(warnings, 1);
  assert.equal(acks, 0);
  await publisher.tick(10, 2000);
  assert.equal(reads, 1);
  fail = false;
  await publisher.tick(40, 3000);
  assert.equal(acks, 1);
  assert.deepEqual(snapshots, [1000, 3000]);
  await publisher.tick(41, 3100);
  assert.equal(reads, 2);
  await publisher.tick(80, 5000);
  assert.equal(reads, 3);
});
test("invalid known identity keeps other players live without inventing an empty roster", () => {
  const roster = new Roster(),
    p = player(),
    other = { ...player(), id: "another-private-id", name: "SecondPlayer" };
  const first = roster.sample([p, other]);
  const invalid = {
    ...p,
    get name(): string {
      throw Error("entity disconnected");
    },
  };
  const next = roster.sample([invalid, other]);
  assert.equal(next.length, 2);
  assert.equal(next[0].id, first[0].id);
  assert.equal(next[0].name, p.name);
  assert.equal(next[0].position, null);
  assert.equal(next[1].position?.x, other.location.x);
  roster.leave(p.id);
  assert.throws(() => roster.sample([invalid, other]));
  assert.throws(() =>
    roster.sample([
      {
        ...p,
        get id(): string {
          throw Error("identity lost");
        },
      },
    ]),
  );
});
test("failed roster enumeration never exports an empty roster", async () => {
  let sent = 0;
  const p = new Publisher(
    "fixture",
    "instance",
    0,
    () => {
      throw Error("not loaded");
    },
    async () => {
      sent++;
    },
    () => {},
    () => {},
  );
  await p.tick(0, 1000);
  assert.equal(sent, 0);
});
