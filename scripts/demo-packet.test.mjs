import { test } from "node:test";
import assert from "node:assert/strict";
import { encodePacket, decodePacket, digest } from "./demo-packet.mjs";
const fixture = () =>
  Object.fromEntries(
    [
      "scenario.json",
      "NOTICE.txt",
      ...[0, 1, 2, 3].map((n) => `stage-${n}.json`),
    ].map((n) => [n, Buffer.from("{}").toString("base64")]),
  );
test("packet round trip and checksum rejection", () => {
  const b = encodePacket(fixture());
  assert.equal(decodePacket(b, digest(b)).size, 6);
  assert.throws(() => decodePacket(b, "0".repeat(64)));
});
test("reject traversal, symlink-shaped entries, malformed content, missing files and false object hashes", () => {
  for (const name of [
    "../secret",
    "/world",
    "objects/link",
    `objects/${"a".repeat(64)}.png`,
  ]) {
    const b = encodePacket({ ...fixture(), [name]: "eA==" });
    assert.throws(() => decodePacket(b, digest(b)));
  }
  for (const files of [
    {},
    { ...fixture(), "scenario.json": { symlink: "/etc" } },
    { ...fixture(), "scenario.json": "!bad" },
  ]) {
    const b = encodePacket(files);
    assert.throws(() => decodePacket(b, digest(b)));
  }
});
test("bounded decompression", () => {
  const b = encodePacket({
    ...fixture(),
    "NOTICE.txt": Buffer.alloc(25 * 1024 * 1024).toString("base64"),
  });
  assert.throws(() => decodePacket(b, digest(b)));
});
