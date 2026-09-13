import { test } from "node:test";
import assert from "node:assert/strict";
import { validTerrainUrl } from "../pack/src/config.ts";
test("terrain endpoint uses operator port but fixed authenticated route", () => {
  assert.equal(
    validTerrainUrl("http://terrain-service:23457/ingest/v1/terrain"),
    true,
  );
  for (const url of [
    "http://terrain-service:0/ingest/v1/terrain",
    "http://terrain-service:65536/ingest/v1/terrain",
    "http://u:p@terrain-service:8082/ingest/v1/terrain",
    "http://terrain-service:8082/other",
    "http://terrain-service:8082/ingest/v1/terrain?url=evil",
  ])
    assert.equal(validTerrainUrl(url), false);
});
