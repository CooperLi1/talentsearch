import assert from "node:assert/strict";
import test from "node:test";

import { resolveWorkerSettings } from "../lib/workers/enrichment-settings";

test("external worker settings use safe operational defaults", () => {
  const settings = resolveWorkerSettings({});
  assert.equal(settings.workspaceId, "1");
  assert.equal(settings.concurrency, 2);
  assert.equal(settings.connectorLimit, 8);
  assert.equal(settings.timeoutMs, 240_000);
  assert.equal(settings.briefEnabled, true);
  assert.equal(settings.briefLimit, 6);
});

test("external worker settings clamp unsafe values", () => {
  const settings = resolveWorkerSettings({
    UNFOUND_WORKSPACE_ID: "7",
    WORKER_ENRICHMENT_CONCURRENCY: "99",
    WORKER_CONNECTORS_PER_PASS: "0",
    WORKER_CANDIDATE_TIMEOUT_MS: "999999",
    WORKER_ENABLE_BRIEFS: "false",
    WORKER_BRIEF_BATCH_LIMIT: "200",
  });
  assert.equal(settings.workspaceId, "7");
  assert.equal(settings.concurrency, 8);
  assert.equal(settings.connectorLimit, 1);
  assert.equal(settings.timeoutMs, 300_000);
  assert.equal(settings.briefEnabled, false);
  assert.equal(settings.briefLimit, 12);
});

test("external worker rejects an invalid workspace", () => {
  assert.throws(
    () => resolveWorkerSettings({ UNFOUND_WORKSPACE_ID: "all" }),
    /positive integer/,
  );
});
