import { test } from "node:test";
import assert from "node:assert/strict";
import { validCollectorUrl } from "../src/config.ts";
test("collector endpoint uses operator port but fixed authenticated route", () => {
  assert.equal(
    validCollectorUrl("http://tracking-service:23456/ingest/v1/snapshot"),
    true,
  );
  for (const url of [
    "http://tracking-service:0/ingest/v1/snapshot",
    "http://tracking-service:65536/ingest/v1/snapshot",
    "http://u:p@tracking-service:8081/ingest/v1/snapshot",
    "http://tracking-service:8081/other",
    "http://tracking-service:8081/ingest/v1/snapshot?url=evil",
  ])
    assert.equal(validCollectorUrl(url), false);
});
