import { test } from "node:test";
import assert from "node:assert/strict";
import { privateReadOrigin } from "./private-origin.mjs";
test("read listeners accept operator-selected ports across private subnets", () => {
  for (const origin of [
    "http://127.0.0.1:34567",
    "http://10.23.45.67:45678",
    "https://172.20.30.40:9443",
    "http://192.168.23.45:12345",
  ])
    assert.equal(privateReadOrigin(origin).origin, origin);
  for (const origin of [
    "http://169.254.169.254/",
    "http://8.8.8.8/",
    "http://example.test:8110",
    "http://172.32.0.1/",
    "ftp://127.0.0.1/",
    "http://u:p@127.0.0.1/",
    "http://127.0.0.1/path",
    "http://127.0.0.1/?url=x",
    "http://127.0.0.1/#x",
  ])
    assert.throws(() => privateReadOrigin(origin));
});
