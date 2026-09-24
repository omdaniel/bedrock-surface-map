import assert from "node:assert/strict";

// These reports bind synthetic acceptance to exact artifacts. They deliberately
// do not substitute for the separately recorded BDS/public-network acceptance.
export function assertGeneratedEvidence(candidate, reports) {
  assert.equal(reports.length, 2, "both native generated reports are required");
  assert.deepEqual(reports.map((r) => r.host).sort(), [
    "linux-arm64",
    "linux-x64",
  ]);
  for (const report of reports) {
    assert.equal(report.schema_version, 1);
    assert.equal(report.scope, "generated-native-deployment");
    assert.equal(report.commit, candidate.commit);
    assert.equal(report.common_sha256, candidate.common_sha256);
    assert.deepEqual(report.images, candidate.images);
    for (const field of [
      "ok",
      "generated_parser_seed",
      "exact_frontend",
      "prepared_startup",
      "private_https",
      "generated_mounts",
      "auth_and_fixed_reads",
      "independent_outage",
      "restart_without_reseed",
      "browser_verified",
      "operator_bundle_verified",
    ])
      assert.equal(report[field], true, `missing generated evidence: ${field}`);
    for (const field of [
      "authorized_source",
      "unauthorized_source_blocked",
      "return_traffic",
      "idempotent_apply_remove",
    ])
      assert.equal(
        report.firewall_evidence?.[field],
        true,
        `missing firewall evidence: ${field}`,
      );
    const browser = report.browser_evidence;
    assert.equal(browser?.ok, true);
    assert.equal(browser.browser_host, report.host);
    assert.deepEqual(browser.cases.map((c) => c.path).sort(), [
      "/",
      "/?players=off",
      "/?terrain=off",
    ]);
    for (const c of browser.cases) {
      assert.ok(c.distinct_pixel_colors >= 8);
      assert.equal(c.picking, "-9 / 65 / -9");
      assert.equal(c.material, "grass");
      assert.equal(c.terrain_live_binding, c.path !== "/?terrain=off");
    }
    const protocol = browser.cases.find((c) => c.path === "/").protocol;
    for (const field of [
      "live_edit",
      "picking",
      "changed_pixels",
      "marker_heading",
      "marker_projection",
      "empty_roster",
      "stale_sample_expiry_and_recovery",
      "rejected_writes",
    ])
      assert.equal(
        protocol?.[field],
        true,
        `missing protocol evidence: ${field}`,
      );
    assert.equal(protocol.player_only_redraws, 0);
    assert.deepEqual(report.single_feed_evidence.map((f) => f.enabled).sort(), [
      "players",
      "terrain",
    ]);
    for (const feed of report.single_feed_evidence) {
      assert.equal(feed.browser.ok, true);
      assert.equal(feed.browser.browser_host, report.host);
      assert.deepEqual(feed.browser.cases.map((c) => c.path).sort(), [
        "/",
        "/?players=off",
        "/?terrain=off",
      ]);
      for (const c of feed.browser.cases) {
        assert.ok(c.distinct_pixel_colors >= 8);
        assert.equal(
          c.terrain_live_binding,
          feed.enabled === "terrain" && c.path !== "/?terrain=off",
        );
      }
    }
  }
}

export function authorizePublication(tag, env = process.env) {
  if (
    env.CI_COMMIT_TAG !== tag ||
    env.CI_COMMIT_REF_PROTECTED !== "true" ||
    env.CI_PIPELINE_SOURCE === "merge_request_event" ||
    env.BEDROCK_MAP_PUBLISH_APPROVED !== "true"
  )
    throw Error(
      "publication requires the matching protected tag and explicit owner approval",
    );
}
