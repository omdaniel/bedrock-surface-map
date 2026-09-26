import assert from "node:assert/strict";
import { test } from "node:test";
import { configuredLodUrl } from "../web/src/config.ts";
import {
  assertLiveRevision,
  catalogAppendPages,
  changedChunks,
  chunkStamp,
  patchPicking,
} from "../web/src/lod/live.ts";
import {
  HEALTH_POLL_BYTES,
  ROOT_POLL_BYTES,
  LodRootSource,
  parsePublicationHealth,
  readBytes,
  type LodFeedState,
} from "../web/src/lod/root-source.ts";
import {
  parseManifest,
  type LodManifest,
  type LodNode,
} from "../web/src/lod/protocol.ts";

const url = new URL("https://example.test/map/lod.json");
test("configured LOD separates the snapshot, live feed, and explicit URL selection", () => {
  const config = {
    lod_url: "maps/snapshot/lod.json",
    terrain: {
      url: "api/v1/worlds/test-world/terrain/manifest.json",
      lod_url: "api/v1/worlds/test-world/terrain/lod.json",
      world_id: "test-world",
      generation: "test-generation",
    },
  };
  const selected = (query: string) =>
    configuredLodUrl(config, new URLSearchParams(query));
  assert.equal(selected(""), config.terrain.lod_url);
  assert.equal(selected("terrain=off"), config.lod_url);
  assert.equal(selected("players=off"), config.terrain.lod_url);
  assert.equal(selected("map=another/manifest.json"), undefined);
  assert.equal(selected("lod=chosen/lod.json&terrain=off"), "chosen/lod.json");
  assert.equal(
    configuredLodUrl({ lod_url: config.lod_url }, new URLSearchParams()),
    config.lod_url,
  );
  assert.equal(
    configuredLodUrl(
      { terrain: config.terrain },
      new URLSearchParams("terrain=off"),
    ),
    undefined,
  );
});
const healthURL = new URL("status", url);
const ref = (letter = "a") => ({
  url: `objects/${letter.repeat(64)}.bin`,
  sha256: letter.repeat(64),
  bytes: 128,
});
const chunk = (cx: number, cz: number, hash = "a") => ({
  cx,
  cz,
  ...ref(hash),
});
const node = (chunks = [chunk(-8, -1), chunk(-1, -8)]): LodNode => ({
  key: { level: 0, x: -1, z: -1 },
  data: ref(),
  height: ref(),
  children: [],
  chunks,
});
function root(): LodManifest {
  return parseManifest(
    {
      kind: "surface-lod",
      format_version: 1,
      name: "Synthetic",
      bounds: [-128, -128, 0, 0],
      spawn: [-64, 64, -64],
      source_sha256: "a".repeat(64),
      generation: "test-generation",
      world_id: "test-world",
      revision: 1,
      appearance_version: "1",
      height_range: [0, 2048],
      atlas: ref(),
      material_count: 2,
      catalog: [{ ...ref(), start: 0, count: 2 }],
      roots: [{ key: node().key, index: ref() }],
    },
    new URL(".", url),
  );
}

function health(status = "live", publication = {}) {
  return {
    schema_version: 1,
    world_id: root().world_id,
    generation: root().generation,
    status,
    reason: "live",
    lod: {
      status: "live",
      revision_lag: 0,
      pending_age_ms: null,
      last_published_ms: 1000,
      reason: null,
      ...publication,
    },
  };
}

test("publication health distinguishes gameplay freshness from publication progress", () => {
  for (const [gameplay, publication, expected] of [
    ["live", "live", "live"],
    ["starting", "live", "starting"],
    ["live", "starting", "starting"],
    ["live", "updating", "updating"],
    ["stale", "live", "stale"],
    ["stale", "updating", "stale"],
    ["degraded", "live", "degraded"],
    ["live", "degraded", "degraded"],
    ["disabled", "live", "disabled"],
    ["live", "disabled", "disabled"],
    ["disabled", "degraded", "disabled"],
  ]) {
    assert.equal(
      parsePublicationHealth(health(gameplay, { status: publication }), root())
        .state,
      expected,
    );
  }
  assert.equal(
    parsePublicationHealth(health("live", { revision_lag: 1 }), root()).state,
    "updating",
  );
  const parsed = parsePublicationHealth(
    {
      ...health("live", {
        status: "updating",
        revision_lag: 3,
        pending_age_ms: 1250,
      }),
      diagnostics: { arbitrary: "ignored" },
    },
    root(),
  );
  assert.deepEqual(parsed, {
    state: "updating",
    publication: {
      status: "updating",
      revision_lag: 3,
      pending_age_ms: 1250,
      last_published_ms: 1000,
      reason: null,
    },
  });
});

test("health identity, statuses and counters are validated; reasons stay bounded", () => {
  for (const patch of [
    { schema_version: 2 },
    { world_id: "other-world" },
    { generation: "other-generation" },
    { world_id: undefined },
    { status: ["live"] },
    { status: "updating" },
    { status: "unknown" },
    { lod: [] },
    { lod: null },
    { reason: { secret: true } },
  ])
    assert.throws(() =>
      parsePublicationHealth({ ...health(), ...patch }, root()),
    );
  assert.throws(
    () => parsePublicationHealth(health(), { ...root(), world_id: undefined }),
    /identity/,
  );
  for (const field of ["revision_lag", "pending_age_ms", "last_published_ms"])
    for (const value of [
      -1,
      0.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
      "1",
      undefined,
    ])
      assert.throws(
        () =>
          parsePublicationHealth(health("live", { [field]: value }), root()),
        /counter/,
      );
  for (const status of [["live"], "stale", "delayed", 1])
    assert.throws(
      () => parsePublicationHealth(health("live", { status }), root()),
      /status/,
    );
  assert.equal(
    parsePublicationHealth(
      health("degraded", { reason: "publication-unavailable" }),
      root(),
    ).publication.reason,
    "publication-unavailable",
  );
  for (const reason of [
    "private\nresponse",
    "a".repeat(81),
    "https://example.test/secret",
  ]) {
    const result = parsePublicationHealth(
      health("degraded", { reason }),
      root(),
    );
    assert.equal(result.publication.reason, "unavailable");
    assert.equal(JSON.stringify(result).includes(reason), false);
  }
  assert.equal(
    parsePublicationHealth(
      { ...health("disabled"), reason: "operator-disabled" },
      root(),
    ).publication.reason,
    "operator-disabled",
  );
});

test("health endpoint must be a fixed same-origin URL without credentials or query data", () => {
  for (const value of [
    "https://other.test/status",
    "http://example.test/status",
    "file:///status",
    "https://user:secret@example.test/status",
    "https://example.test/status?token=secret",
    "https://example.test/status#fragment",
    `https://example.test/${"a".repeat(2048)}`,
  ])
    assert.throws(
      () =>
        new LodRootSource(
          url,
          root(),
          async () => {},
          () => true,
          () => {},
          () => {},
          new URL(value),
        ),
    );
  assert.ok(ROOT_POLL_BYTES >= (65536 + HEALTH_POLL_BYTES) * 10);
  assert.equal(HEALTH_POLL_BYTES, 16384);
});

test("resident revision stamps preserve signed coordinates and unsigned hashes compactly", () => {
  const before = node([chunk(-8, -1, "f"), chunk(-1, -8, "b")]);
  const stamp = chunkStamp(before.chunks);
  assert.equal(stamp.byteLength, 80);
  const after = node([
    chunk(-1, -8, "c"),
    chunk(-8, -1, "f"),
    chunk(-2, -2, "e"),
  ]);
  assert.deepEqual(changedChunks(stamp, after), [
    after.chunks![0],
    after.chunks![2],
  ]);
  assert.equal(changedChunks(stamp, node([before.chunks![0]])), null);
  assert.equal(changedChunks(stamp, before), null);
  assert.equal(changedChunks(new Int32Array(), after), null);
});

test("picking patches replace complete negative-coordinate chunks only after validation", () => {
  const pick = new Int32Array(128 * 128 * 2).fill(9);
  const values = new Int32Array(1024).fill(4);
  values.fill(7, 512);
  patchPicking(pick, node().key, new Int32Array([-8, -1, -1, -8]), values);
  assert.equal(pick[112 * 128 * 2], 4);
  assert.equal(pick[112 * 2], 7);
  assert.equal(pick[0], 9);
  const saved = pick.slice();
  for (const coords of [
    [-8, -1, 0, -1],
    [-8, -1, -8, -1],
  ]) {
    assert.throws(() =>
      patchPicking(pick, node().key, new Int32Array(coords), values),
    );
    assert.deepEqual(pick, saved);
  }
});

test("live identity and catalog epochs reject regression and distinguish append-only pages", () => {
  const before = root();
  for (const patch of [
    { revision: 0 },
    { world_id: "other" },
    { generation: "other" },
  ])
    assert.throws(() => assertLiveRevision(before, { ...before, ...patch }));
  assert.doesNotThrow(() =>
    assertLiveRevision(before, { ...before, revision: 2 }),
  );
  assert.deepEqual(catalogAppendPages(before, before), []);
  assert.equal(
    catalogAppendPages(before, { ...before, atlas: ref("b") }),
    null,
  );
  assert.equal(
    catalogAppendPages(before, {
      ...before,
      catalog: [{ ...before.catalog[0], ...ref("b") }],
    }),
    null,
  );
  const after = {
    ...before,
    material_count: 3,
    catalog: [{ ...before.catalog[0], count: 3, ...ref("c") }],
  };
  assert.deepEqual(catalogAppendPages(before, after), [
    { before: before.catalog[0], after: after.catalog[0] },
  ]);
});

test("bounded HTTP reads reject errors, excess data and truncated declared objects", async () => {
  await assert.rejects(
    readBytes(new Response("bad", { status: 503 }), 16),
    /HTTP 503/,
  );
  await assert.rejects(readBytes(new Response("abc"), 2), /reservation/);
  await assert.rejects(
    readBytes(new Response("abc", { headers: { "Content-Length": "99" } }), 16),
    /length limit/,
  );
  await assert.rejects(readBytes(new Response("abc"), 4, 4), /Truncated/);
  assert.equal(
    new TextDecoder().decode(await readBytes(new Response("ok"), 16)),
    "ok",
  );
});

async function until(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.ok(predicate(), "asynchronous source did not settle");
}

test("root polling revalidates, serializes admission, retains failures and suspends hidden reads", async () => {
  const original = globalThis.fetch;
  let reply: () => Promise<Response> = async () =>
    Response.json(root(), { headers: { ETag: '"1"' } });
  let requests = 0,
    reservations = 0,
    released = 0;
  let headers: HeadersInit | undefined;
  const accepted: number[] = [];
  let unblock: (() => void) | undefined;
  globalThis.fetch = async (_input, options) => {
    requests++;
    headers = options?.headers;
    return reply();
  };
  const source = new LodRootSource(
    url,
    root(),
    async (next) => {
      accepted.push(next.revision);
      if (next.revision === 2)
        await new Promise<void>((resolve) => {
          unblock = resolve;
        });
    },
    () => {
      reservations++;
      return true;
    },
    () => {
      released++;
    },
    () => {},
  );
  try {
    source.refresh();
    await until(() => released === 1);
    assert.deepEqual(accepted, []);
    reply = async () => new Response(null, { status: 304 });
    source.refresh();
    await until(() => released === 2);
    assert.equal(new Headers(headers).get("If-None-Match"), '"1"');
    reply = async () => Response.json({ ...root(), revision: 2 });
    source.refresh();
    await until(() => Boolean(unblock));
    source.refresh();
    assert.equal(requests, 3);
    source.visibility(false);
    unblock!();
    await until(() => released === 3);
    source.refresh();
    assert.equal(requests, 3);
    reply = async () => Response.json({ ...root(), revision: 0 });
    source.visibility(true);
    await until(() => released === 4);
    assert.equal(source.state, "delayed");
    assert.match(source.error!, /backwards/);
    reply = async () => Response.json({ ...root(), revision: 3 });
    source.refresh();
    await until(() => released === 5);
    assert.deepEqual(accepted, [2, 3]);
    assert.equal(source.state, "live");
    assert.equal(reservations, released);
  } finally {
    source.destroy();
    globalThis.fetch = original;
  }
});

test("root 304 still polls health and changes lag/degraded status without terrain admission", async (t) => {
  let cycle = 0,
    accepted = 0,
    reserved = 0,
    released = 0;
  const requests: string[] = [];
  const statuses: LodFeedState[] = [];
  const responses = [
    health(),
    health("live", {
      status: "updating",
      revision_lag: 2,
      pending_age_ms: 4000,
    }),
    health("live", {
      status: "degraded",
      revision_lag: 2,
      pending_age_ms: 31000,
      reason: "publication-unavailable",
    }),
    health("stale"),
    health("disabled"),
  ];
  t.mock.method(
    globalThis,
    "fetch",
    async (input: URL, options?: RequestInit) => {
      requests.push(input.href);
      assert.equal(options?.redirect, "error");
      assert.equal(options?.cache, "no-cache");
      if (input.href === url.href) {
        if (cycle) {
          assert.equal(
            new Headers(options?.headers).get("If-None-Match"),
            '"1"',
          );
          return new Response(null, { status: 304 });
        }
        return Response.json(root(), { headers: { ETag: '"1"' } });
      }
      assert.equal(input.href, healthURL.href);
      assert.equal(new Headers(options?.headers).get("If-None-Match"), null);
      return Response.json(responses[cycle++]);
    },
  );
  const configuredURL = new URL(healthURL);
  const source = new LodRootSource(
    url,
    root(),
    async () => {
      accepted++;
    },
    () => {
      reserved++;
      return true;
    },
    () => {
      released++;
    },
    (state) => statuses.push(state),
    configuredURL,
  );
  configuredURL.pathname = "/mutated";
  t.after(() => source.destroy());
  assert.equal(source.state, "starting");
  assert.equal(source.publication, null);
  for (let i = 1; i <= responses.length; i++) {
    source.refresh();
    await until(() => released === i);
    assert.deepEqual(source.publication, responses[i - 1].lod);
  }
  assert.deepEqual(statuses, [
    "live",
    "updating",
    "degraded",
    "stale",
    "disabled",
  ]);
  assert.equal(accepted, 0);
  assert.equal(reserved, released);
  assert.deepEqual(
    requests,
    responses.flatMap(() => [url.href, healthURL.href]),
  );
});

test("health failure retains terrain and last diagnostics, uses delayed state, and recovers", async (t) => {
  let released = 0,
    revision = 1,
    accepted = 0;
  let healthResponse = () => Response.json(health("live", { revision_lag: 1 }));
  const errors: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: URL) =>
    input.href === url.href
      ? Response.json({ ...root(), revision })
      : healthResponse(),
  );
  const source = new LodRootSource(
    url,
    root(),
    async () => {
      accepted++;
    },
    () => true,
    () => {
      released++;
    },
    () => {},
    healthURL,
  );
  t.after(() => source.destroy());
  source.refresh();
  await until(() => released === 1);
  const last = source.publication;
  const failures = [
    () => new Response("untrusted body", { status: 503 }),
    () => Response.json({ ...health(), world_id: "wrong-world" }),
    () => Response.json({ ...health(), generation: "wrong-generation" }),
    () => new Response("private-invalid-json"),
    () =>
      new Response("ok", {
        headers: { "Content-Length": String(HEALTH_POLL_BYTES + 1) },
      }),
    () => new Response(" ".repeat(HEALTH_POLL_BYTES + 1)),
  ];
  for (let i = 0; i < failures.length; i++) {
    revision = 2;
    healthResponse = failures[i];
    source.refresh();
    await until(() => released === i + 2);
    assert.equal(source.state, "delayed");
    assert.equal(source.publication, last);
    errors.push(source.error!);
  }
  assert.equal(
    accepted,
    1,
    "health errors must not discard or repeatedly admit terrain",
  );
  assert.ok(
    errors.every(
      (error) =>
        !error.includes("private-invalid-json") &&
        !error.includes("untrusted body"),
    ),
  );
  healthResponse = () => Response.json(health());
  source.refresh();
  await until(() => released === failures.length + 2);
  assert.equal(source.state, "live");
  assert.equal(source.error, null);
  assert.equal(source.publication!.revision_lag, 0);
});

test("a blocked health request keeps one cycle and reservation until cancellation drains", async (t) => {
  let requests = 0,
    released = 0,
    reserved = 0,
    unblock!: (response: Response) => void;
  let signal: AbortSignal | undefined;
  let blocked = true;
  const statuses: LodFeedState[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (input: URL, options?: RequestInit) => {
      requests++;
      if (input.href === url.href) return new Response(null, { status: 304 });
      signal = options?.signal ?? undefined;
      if (blocked)
        return new Promise<Response>((resolve) => {
          unblock = resolve;
        });
      return Response.json(health());
    },
  );
  const source = new LodRootSource(
    url,
    root(),
    async () => assert.fail("unchanged terrain admitted"),
    () => {
      reserved++;
      return true;
    },
    () => {
      released++;
    },
    (state) => statuses.push(state),
    healthURL,
  );
  t.after(() => source.destroy());
  source.refresh();
  await until(() => Boolean(unblock));
  source.refresh();
  source.refresh();
  assert.equal(requests, 2);
  assert.equal(reserved, 1);
  assert.equal(released, 0);
  source.visibility(false);
  assert.equal(signal!.aborted, true);
  assert.equal(released, 0);
  unblock(Response.json(health()));
  await until(() => released === 1);
  assert.deepEqual(statuses, []);
  assert.equal(source.publication, null);
  source.refresh();
  assert.equal(requests, 2);
  blocked = false;
  source.visibility(true);
  await until(() => released === 2);
  source.destroy();
  assert.equal(requests, 4);
  assert.deepEqual(statuses, ["live"]);
  assert.equal(reserved, released);
});

test("failed admission and root errors never start an unreserved health request", async (t) => {
  let allow = false,
    released = 0,
    requests = 0,
    notifications = 0;
  t.mock.method(globalThis, "fetch", async (input: URL) => {
    requests++;
    assert.equal(input.href, url.href);
    return new Response(null, { status: 503 });
  });
  const source = new LodRootSource(
    url,
    root(),
    async () => {},
    () => allow,
    () => {
      released++;
    },
    () => {
      notifications++;
    },
    healthURL,
  );
  t.after(() => source.destroy());
  source.refresh();
  await until(() => notifications === 1);
  assert.equal(source.state, "delayed");
  assert.equal(requests, 0);
  assert.equal(released, 0);
  allow = true;
  source.refresh();
  await until(() => released === 1);
  assert.equal(requests, 1);
  assert.equal(source.publication, null);
});

test("health failures retain exponential backoff and a successful poll resets the interval", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let released = 0,
    requests = 0,
    healthy = false;
  t.mock.method(globalThis, "fetch", async (input: URL) => {
    requests++;
    return input.href === url.href
      ? new Response(null, { status: 304 })
      : healthy
        ? Response.json(health())
        : new Response(null, { status: 503 });
  });
  const source = new LodRootSource(
    url,
    root(),
    async () => {},
    () => true,
    () => {
      released++;
    },
    () => {},
    healthURL,
  );
  t.after(() => source.destroy());
  source.refresh();
  await until(() => released === 1);
  for (const delay of [4000, 8000]) {
    const before = requests,
      completed = released;
    t.mock.timers.tick(delay - 1);
    assert.equal(requests, before);
    t.mock.timers.tick(1);
    await until(() => released === completed + 1);
    assert.equal(requests, before + 2);
  }
  healthy = true;
  t.mock.timers.tick(16000);
  await until(() => released === 4);
  assert.equal(source.state, "live");
  t.mock.timers.tick(1999);
  assert.equal(requests, 8);
  t.mock.timers.tick(1);
  await until(() => released === 5);
  assert.equal(requests, 10);
  source.destroy();
  t.mock.timers.tick(60000);
  assert.equal(requests, 10);
});
