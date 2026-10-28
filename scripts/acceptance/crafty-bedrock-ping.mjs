import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";
import { isIP } from "node:net";

// RakNet offline ping/pong, without connecting a player. Wire reference:
// https://github.com/Sandertv/go-raknet/tree/v1.15.1/internal/message
export const magic = Buffer.from("00ffff00fefefefefdfdfdfd12345678", "hex");
export function readPong(bytes, timestamp) {
  assert.ok(
    bytes.length >= 35 && bytes.length <= 4096,
    "game advertisement unavailable",
  );
  assert.equal(bytes[0], 0x1c);
  assert.equal(bytes.readBigUInt64BE(1), timestamp);
  assert.ok(bytes.subarray(17, 33).equals(magic));
  const length = bytes.readUInt16BE(33);
  assert.ok(length > 0 && length <= bytes.length - 35);
  const fields = bytes
    .subarray(35, 35 + length)
    .toString("utf8")
    .split(";");
  assert.equal(fields[0], "MCPE");
  assert.match(fields[2] ?? "", /^\d{1,5}$/);
  assert.match(fields[3] ?? "", /^\d{1,3}(?:\.\d{1,3}){2,3}$/);
  for (const n of [fields[4], fields[5]]) assert.match(n ?? "", /^\d{1,6}$/);
  // Do not retain MOTD, server identifiers or world names.
  return {
    protocol: Number(fields[2]),
    version: fields[3],
    players: Number(fields[4]),
    max_players: Number(fields[5]),
  };
}
export function pingBedrock(host, port = 19132, timeout = 1500) {
  assert.equal(isIP(host), 4, "use the isolated server's literal IPv4 address");
  assert.ok(Number.isSafeInteger(port) && port > 0 && port <= 65535);
  return new Promise((resolve, reject) => {
    const socket = createSocket("udp4"),
      timestamp = BigInt(Date.now());
    const bytes = Buffer.alloc(33);
    bytes[0] = 0x01;
    bytes.writeBigUInt64BE(timestamp, 1);
    magic.copy(bytes, 9);
    randomBytes(8).copy(bytes, 25);
    const timer = setTimeout(
      () =>
        finish(
          Object.assign(Error("game status deadline"), { code: "ETIMEDOUT" }),
        ),
      timeout,
    );
    let done = false;
    function finish(error, value) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else resolve(value);
    }
    socket.on("error", (error) => finish(error));
    socket.on("message", (response, remote) => {
      if (remote.address !== host || remote.port !== port) return;
      try {
        finish(null, readPong(response, timestamp));
      } catch (error) {
        finish(error);
      }
    });
    socket.send(bytes, port, host, (error) => {
      if (error) finish(error);
    });
  });
}
