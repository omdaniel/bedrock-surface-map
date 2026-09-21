import assert from "node:assert/strict";
import { test } from "node:test";
import { assertBrowserEvidence } from "./evidence.mjs";

test("cross-host browser evidence binds both mounts to exact archive and commit", () => {
  const report = {
    ok: true,
    browser_rendered: true,
    terrain_pixels: true,
    picking: true,
    browser_host: "darwin-arm64",
    mount_paths: ["/", "/map/"],
    archive_sha256: "a".repeat(64),
    commit: "b".repeat(40),
  };
  assert.equal(
    assertBrowserEvidence(report, report.archive_sha256, report.commit),
    report,
  );
  for (const change of [
    { archive_sha256: "c".repeat(64) },
    { commit: "d".repeat(40) },
    { mount_paths: ["/"] },
    { terrain_pixels: false },
    { browser_host: "" },
  ]) {
    assert.throws(
      () =>
        assertBrowserEvidence(
          { ...report, ...change },
          report.archive_sha256,
          report.commit,
        ),
      /browser evidence/,
    );
  }
});
