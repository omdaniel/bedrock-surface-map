import assert from "node:assert/strict";
import test from "node:test";
import { unusedClientSubnet } from "./generated-firewall.mjs";

test("CI client routing never overlaps existing connected or local routes", () => {
  assert.equal(
    unusedClientSubnet([{ dst: "default" }, { dst: "10.249.0.2" }]),
    "10.249.1",
  );
  assert.equal(
    unusedClientSubnet([{ dst: "10.0.0.0/8" }, { dst: "172.30.0.0/16" }]),
    "192.168.0",
  );
  assert.throws(
    () =>
      unusedClientSubnet([
        { dst: "10.0.0.0/8" },
        { dst: "172.16.0.0/12" },
        { dst: "192.168.0.0/16" },
      ]),
    /no unused/,
  );
});
