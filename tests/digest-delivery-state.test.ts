import assert from "node:assert/strict";
import test from "node:test";

import { digestStatusAfterDelivery } from "../lib/digest/delivery-state";

test("sent and failed deliveries retain their terminal status", () => {
  assert.equal(digestStatusAfterDelivery({
    status: "sent",
    digestId: "digest-1",
    subject: "Weekly digest",
    recipientCount: 1,
    candidateCount: 1,
    batches: [],
  }), "sent");
  assert.equal(digestStatusAfterDelivery({
    status: "failed",
    digestId: "digest-1",
    subject: "Weekly digest",
    recipientCount: 1,
    candidateCount: 1,
    batches: [],
    error: {
      name: "provider_error",
      message: "Provider rejected the request",
      statusCode: 500,
    },
  }), "failed");
});

test("preview deliveries remain retryable", () => {
  assert.equal(digestStatusAfterDelivery({
    status: "preview",
    reason: "delivery-disabled",
    digestId: "digest-1",
    subject: "Weekly digest",
    recipientCount: 1,
    candidateCount: 1,
  }), "ready");
});

test("skipped deliveries become terminal so they cannot block later digests", () => {
  assert.equal(digestStatusAfterDelivery({
    status: "skipped",
    reason: "no-candidates",
    digestId: "digest-1",
    subject: "Weekly digest",
    recipientCount: 1,
    candidateCount: 0,
  }), "cancelled");
  assert.equal(digestStatusAfterDelivery({
    status: "skipped",
    reason: "no-recipients",
    digestId: "digest-1",
    subject: "Weekly digest",
    recipientCount: 0,
    candidateCount: 1,
  }), "cancelled");
});
