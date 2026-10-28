import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import test from "node:test";
import { magic, pingBedrock, readPong } from "./crafty-bedrock-ping.mjs";

function pong(
  timestamp,
  text = "MCPE;Synthetic server;999;1.26.45;0;1;private-id;private-world;",
) {
  const body = Buffer.from(text),
    bytes = Buffer.alloc(35 + body.length);
  bytes[0] = 0x1c;
  bytes.writeBigUInt64BE(timestamp, 1);
  magic.copy(bytes, 17);
  bytes.writeUInt16BE(body.length, 33);
  body.copy(bytes, 35);
  return bytes;
}
test("Bedrock status validates its nonce/length and omits private advertisement fields", () => {
  const stamp = 123n,
    bytes = pong(stamp);
  assert.deepEqual(readPong(bytes, stamp), {
    protocol: 999,
    version: "1.26.45",
    players: 0,
    max_players: 1,
  });
  assert.throws(() => readPong(bytes, 124n));
  assert.throws(() => readPong(bytes.subarray(0, 36), stamp));
  assert.throws(() => readPong(bytes.subarray(0, 33), stamp));
  assert.throws(() => readPong(pong(stamp, "invalid"), stamp));
});
test("status query uses an unconnected packet and a bounded UDP response", async () => {
  const server = createSocket("udp4");
  await new Promise((r) => server.bind(0, "127.0.0.1", r));
  server.on("message", (bytes, remote) => {
    assert.equal(bytes.length, 33);
    assert.equal(bytes[0], 1);
    assert.ok(bytes.subarray(9, 25).equals(magic));
    server.send(pong(bytes.readBigUInt64BE(1)), remote.port, remote.address);
  });
  try {
    assert.equal(
      (await pingBedrock("127.0.0.1", server.address().port)).players,
      0,
    );
  } finally {
    server.close();
  }
});
