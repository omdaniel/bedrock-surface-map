import assert from "node:assert/strict";
import { createHash } from "node:crypto";

// Resolved from the official 4.11.0 registry index and corresponding GitLab tag.
// Updating either pin requires reviewing that release's auth/import/action APIs.
export const CRAFTY = Object.freeze({
  version: "4.11.0",
  revision: "fe65b372a4388552e9f4a1fe54251b2321f042fa",
  image:
    "registry.gitlab.com/crafty-controller/crafty-4@sha256:7b6e87514259549647e15ceeaf73d238792e6d77e2c79fc744d5badc8d6e997c",
  amd64:
    "sha256:224de96048a5bb7319aff1068f509a904849edb3fe8caabe24a90da65e52d366",
  amd64_config:
    "sha256:90d1a3b91ac2a79a965a7bcf342e9702d22b828e0ae72bb4df471b460b64017e",
  source:
    "https://gitlab.com/crafty-controller/crafty-4/-/tree/fe65b372a4388552e9f4a1fe54251b2321f042fa",
  api: "https://docs.craftycontrol.com/pages/developer-guide/api-reference/v2/",
});

// The hash is the repository's recorded compatibility pin, not a claim that
// Mojang publishes checksums. The opt-in run hashes the actual official bytes.
export const BDS = Object.freeze({
  version: "1.26.45.1",
  sha256: "b0db86098ee418a9bb226f6f3f51ff2be36542236839375627b29aef3dfa5cda",
  url: "https://www.minecraft.net/bedrockdedicatedserver/bin-linux/bedrock-server-1.26.45.1.zip",
  source: "https://www.minecraft.net/en-us/download/server/bedrock",
  eula: "https://www.minecraft.net/en-us/eula",
});

export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");

export function requireDisposable(
  env = process.env,
  platform = process.platform,
  arch = process.arch,
) {
  assert.equal(platform, "linux", "acceptance requires Linux");
  assert.equal(arch, "x64", "official Linux BDS fixture requires AMD64");
  assert.equal(env.GITHUB_ACTIONS, "true", "requires GitHub Actions");
  assert.equal(
    env.RUNNER_ENVIRONMENT,
    "github-hosted",
    "requires a disposable GitHub-hosted runner",
  );
  assert.equal(
    env.GITHUB_EVENT_NAME,
    "workflow_dispatch",
    "manual execution only",
  );
  assert.equal(
    env.CRAFTY_DOWNLOAD_BDS,
    "true",
    "BDS download must be explicitly opted in",
  );
  assert.equal(
    env.CRAFTY_ACCEPT_MINECRAFT_EULA,
    "true",
    `explicit acceptance of ${BDS.eula} is required`,
  );
  assert.match(
    env.CRAFTY_SOURCE_SHA ?? "",
    /^[a-f0-9]{40}$/,
    "select an exact source commit",
  );
}

export function validatePackagingRun(run, repository, commit) {
  assert.match(commit, /^[a-f0-9]{40}$/);
  assert.equal(run.repository?.full_name, repository);
  assert.equal(run.path, ".github/workflows/deployment.yml");
  assert.equal(run.name, "Deployment Packaging");
  assert.equal(run.status, "completed");
  assert.equal(
    run.conclusion,
    "success",
    "packaging failures are not acceptance inputs",
  );
  assert.equal(
    run.head_sha,
    commit,
    "packaging and selected source must match exactly",
  );
}

export function bedrockImport() {
  return {
    name: "Disposable BDS acceptance",
    monitoring_type: "minecraft_bedrock",
    minecraft_bedrock_monitoring_data: { host: "127.0.0.1", port: 19132 },
    create_type: "minecraft_bedrock",
    minecraft_bedrock_create_data: {
      create_type: "import_server",
      import_server_create_data: {
        archive_name: "official-bds.zip",
        archive_internal_path: "",
        executable: "bedrock_server",
        // main_controller defaults this otherwise to the schema's echo example.
        command: "./bedrock_server",
      },
    },
    stop_command: "stop",
    autostart: false,
    crashdetection: false,
  };
}

// Keep all raw panel and BDS output private. Evidence contains only classifications.
export function inspectBdsLogs(lines) {
  assert.ok(Array.isArray(lines) && lines.every((v) => typeof v === "string"));
  const text = lines.join("\n");
  assert.ok(Buffer.byteLength(text) <= 8 * 1024 ** 2, "BDS log bound exceeded");
  const count = (re) => lines.filter((line) => re.test(line)).length;
  return {
    lines_inspected: lines.length,
    starts: count(/Server started\./i),
    expected_version_seen: text.includes(`Version: ${BDS.version}`),
    player_connections: count(/Player connected:|Player Spawned:/i),
    script_errors: count(
      /\[Scripting\]\s*\[error\]|\[Scripting\].*(?:Error:|Exception|failed|unhandled)|\[Content\s*Log\].*\[error\]/i,
    ),
    export_warnings: count(
      /Surface tracker export unavailable|Terrain configuration invalid|Surface tracker configuration missing|TLSOnlyError|Module.*not (?:found|allowed)|Plugin.*failed/i,
    ),
  };
}

export function assertEmptyLive(players, terrain, previous) {
  assert.equal(players.status, "live");
  assert.ok(players.age_ms >= 0 && players.age_ms < 15000);
  const snapshot = players.snapshot;
  assert.ok(snapshot && Array.isArray(snapshot.players));
  assert.deepEqual(
    snapshot.players,
    [],
    "this fixture never connects a player",
  );
  assert.equal(terrain.world_id, players.world_id);
  assert.equal(terrain.status, "live");
  assert.ok(terrain.sample_age_ms >= 0 && terrain.sample_age_ms < 15000);
  for (const key of [
    "errors",
    "scan_errors",
    "send_errors",
    "completed",
    "active_chunks",
    "overflow",
  ])
    assert.equal(
      terrain.diagnostics[key],
      0,
      `unexpected terrain diagnostic: ${key}`,
    );
  if (previous) {
    assert.equal(snapshot.instance_id, previous.instance_id);
    assert.ok(
      snapshot.sequence > previous.sequence,
      "require recurring real BDS heartbeats",
    );
    assert.ok(snapshot.sampled_at_ms > previous.sampled_at_ms);
  }
  return {
    instance_id: snapshot.instance_id,
    sequence: snapshot.sequence,
    sampled_at_ms: snapshot.sampled_at_ms,
    pack_version: snapshot.pack_version,
  };
}

// Bedrock level.dat is an 8-byte header and uncompressed little-endian NBT.
// Preserve every existing tag byte-for-byte; change only this NEW disposable
// world's experiment compound. No LevelDB or persistent-world migration occurs.
export function enableDisposableBetaApis(input) {
  assert.ok(Buffer.isBuffer(input) && input.length <= 4 * 1024 ** 2);
  assert.ok(
    input.length >= 12 && input.readUInt32LE(4) === input.length - 8,
    "invalid level.dat header",
  );
  let offset = 8,
    tags = 0;
  const need = (length) => {
    assert.ok(
      Number.isSafeInteger(length) &&
        length >= 0 &&
        offset + length <= input.length,
      "truncated NBT",
    );
  };
  const skip = (length) => {
    need(length);
    offset += length;
  };
  const u8 = () => {
    need(1);
    return input[offset++];
  };
  const str = () => {
    need(2);
    const n = input.readUInt16LE(offset);
    offset += 2;
    need(n);
    const value = input.toString("utf8", offset, offset + n);
    offset += n;
    return value;
  };
  const i32 = () => {
    need(4);
    const n = input.readInt32LE(offset);
    offset += 4;
    assert.ok(n >= 0 && n <= 4 * 1024 ** 2, "NBT collection bound");
    return n;
  };
  function payload(type, depth) {
    assert.ok(depth < 64 && ++tags < 100000, "NBT nesting/tag bound");
    const fixed = { 1: 1, 2: 2, 3: 4, 4: 8, 5: 4, 6: 8 }[type];
    if (fixed) skip(fixed);
    else if (type === 7) skip(i32());
    else if (type === 8) str();
    else if (type === 9) {
      const item = u8(),
        length = i32();
      assert.ok(item !== 0 || length === 0);
      for (let i = 0; i < length; i++) payload(item, depth + 1);
    } else if (type === 10) {
      while (true) {
        const next = u8();
        if (!next) break;
        str();
        payload(next, depth + 1);
      }
    } else if (type === 11) skip(i32() * 4);
    else if (type === 12) skip(i32() * 8);
    else throw Error("unsupported NBT type");
  }
  assert.equal(u8(), 10, "level.dat root must be compound");
  str();
  const rootStart = offset,
    entries = [];
  let experiments;
  while (true) {
    const start = offset,
      type = u8();
    if (!type) break;
    const name = str(),
      body = offset;
    payload(type, 1);
    if (name === "experiments") {
      assert.equal(type, 10);
      assert.equal(experiments, undefined, "duplicate experiments");
      experiments = input.subarray(body, offset - 1);
    } else entries.push(input.subarray(start, offset));
  }
  assert.equal(offset, input.length, "trailing NBT data");
  const byteTag = (name) => {
    const n = Buffer.from(name);
    const length = Buffer.alloc(2);
    length.writeUInt16LE(n.length);
    return Buffer.concat([Buffer.from([1]), length, n, Buffer.from([1])]);
  };
  // Existing experiments may contain additional flags; retain those unchanged.
  const kept = [];
  if (experiments) {
    const end = input.length;
    offset = experiments.byteOffset - input.byteOffset;
    const limit = offset + experiments.length;
    const names = new Set();
    while (offset < limit) {
      const start = offset,
        type = u8(),
        name = str();
      assert.ok(!names.has(name), "duplicate experiment tag");
      names.add(name);
      payload(type, 1);
      if (
        ![
          "gametest",
          "experiments_ever_used",
          "saved_with_toggled_experiments",
        ].includes(name)
      )
        kept.push(input.subarray(start, offset));
    }
    assert.equal(offset, limit);
    assert.ok(limit < end);
  }
  const name = Buffer.from("experiments");
  const nameLength = Buffer.alloc(2);
  nameLength.writeUInt16LE(name.length);
  const body = Buffer.concat([
    input.subarray(8, rootStart),
    ...entries,
    Buffer.from([10]),
    nameLength,
    name,
    ...kept,
    byteTag("gametest"),
    byteTag("experiments_ever_used"),
    byteTag("saved_with_toggled_experiments"),
    Buffer.from([0, 0]),
  ]);
  const header = Buffer.from(input.subarray(0, 8));
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}
