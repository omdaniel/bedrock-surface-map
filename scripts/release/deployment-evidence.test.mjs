import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertGeneratedEvidence,
  authorizePublication,
} from "./deployment-evidence.mjs";
import { publishDeployment } from "./publish-deployment.mjs";

function fixture() {
  const candidate = {
    commit: "a".repeat(40),
    common_sha256: "b".repeat(64),
    images: {
      runtime: { index_digest: `sha256:${"c".repeat(64)}` },
      gateway: { index_digest: `sha256:${"d".repeat(64)}` },
    },
  };
  const reports = ["linux-x64", "linux-arm64"].map((host) => {
    const cases = (terrain) =>
      ["/", "/?terrain=off", "/?players=off"].map((path) => ({
        path,
        picking: "-9 / 65 / -9",
        material: "grass",
        distinct_pixel_colors: 19,
        terrain_live_binding: terrain && path !== "/?terrain=off",
      }));
    const both = cases(true);
    both[0].protocol = {
      live_edit: true,
      picking: true,
      changed_pixels: true,
      marker_heading: true,
      marker_projection: true,
      empty_roster: true,
      stale_sample_expiry_and_recovery: true,
      rejected_writes: true,
      player_only_redraws: 0,
    };
    return {
      ...structuredClone(candidate),
      schema_version: 1,
      scope: "generated-native-deployment",
      host,
      ok: true,
      generated_parser_seed: true,
      exact_frontend: true,
      prepared_startup: true,
      private_https: true,
      generated_mounts: true,
      auth_and_fixed_reads: true,
      independent_outage: true,
      restart_without_reseed: true,
      browser_verified: true,
      operator_bundle_verified: true,
      browser_evidence: { ok: true, browser_host: host, cases: both },
      firewall_evidence: {
        authorized_source: true,
        unauthorized_source_blocked: true,
        return_traffic: true,
        idempotent_apply_remove: true,
      },
      single_feed_evidence: ["terrain", "players"].map((enabled) => ({
        enabled,
        browser: {
          ok: true,
          browser_host: host,
          cases: cases(enabled === "terrain"),
        },
      })),
    };
  });
  return { candidate, reports };
}

test("deployment release evidence binds both native generated stacks and protocol effects", () => {
  const { candidate, reports } = fixture();
  assertGeneratedEvidence(candidate, reports);
  for (const mutate of [
    (r) => r.pop(),
    (r) => {
      r[1].host = r[0].host;
    },
    (r) => {
      r[0].commit = "e".repeat(40);
    },
    (r) => {
      r[0].common_sha256 = "f".repeat(64);
    },
    (r) => {
      r[0].images.runtime.index_digest = "different";
    },
    (r) => {
      r[0].private_https = false;
    },
    (r) => {
      r[0].restart_without_reseed = false;
    },
    (r) => {
      r[0].operator_bundle_verified = false;
    },
    (r) => {
      r[0].firewall_evidence.unauthorized_source_blocked = false;
    },
    (r) => {
      r[0].browser_evidence.cases[0].distinct_pixel_colors = 1;
    },
    (r) => {
      r[0].browser_evidence.cases[0].protocol.changed_pixels = false;
    },
    (r) => {
      r[0].browser_evidence.cases[0].protocol.player_only_redraws = 1;
    },
    (r) => {
      r[0].browser_evidence.cases[1].terrain_live_binding = true;
    },
    (r) => {
      r[0].single_feed_evidence.pop();
    },
    (r) => {
      r[0].single_feed_evidence[1].browser.cases[0].terrain_live_binding = true;
    },
  ]) {
    const altered = structuredClone(reports);
    mutate(altered);
    assert.throws(() => assertGeneratedEvidence(candidate, altered));
  }
});

test("public upload requires matching protected tag and explicit owner approval", async () => {
  const env = {
    CI_COMMIT_TAG: "v0.1.0",
    CI_COMMIT_REF_PROTECTED: "true",
    CI_PIPELINE_SOURCE: "push",
    BEDROCK_MAP_PUBLISH_APPROVED: "true",
  };
  authorizePublication("v0.1.0", env);
  for (const key of Object.keys(env).filter(
    (key) => key !== "CI_PIPELINE_SOURCE",
  ))
    assert.throws(
      () => authorizePublication("v0.1.0", { ...env, [key]: "wrong" }),
      /protected tag/,
    );
  assert.throws(
    () =>
      authorizePublication("v0.1.0", {
        ...env,
        CI_PIPELINE_SOURCE: "merge_request_event",
      }),
    /protected tag/,
  );
  // No registry or filesystem access occurs before approval.
  if (process.env.BEDROCK_MAP_PUBLISH_APPROVED !== "true")
    await assert.rejects(
      publishDeployment(
        "/does-not-exist",
        "/does-not-exist",
        "0.1.0",
        "a".repeat(40),
      ),
      /protected tag/,
    );
});
