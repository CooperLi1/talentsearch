import assert from "node:assert/strict";
import test from "node:test";

import { consumeLocalRateLimit } from "@/lib/security/rate-limit-window";

test("fixed-window rate limiting allows the budget and rejects the next request", () => {
  const policy = { bucket: "test", limit: 2, windowSeconds: 60 };
  const first = consumeLocalRateLimit("client-a", policy, 10_000);
  const second = consumeLocalRateLimit("client-a", policy, 10_001);
  const third = consumeLocalRateLimit("client-a", policy, 10_002);

  assert.equal(first.allowed, true);
  assert.equal(first.remaining, 1);
  assert.equal(second.allowed, true);
  assert.equal(second.remaining, 0);
  assert.equal(third.allowed, false);
  assert.equal(third.retryAfterSeconds, 50);
});

test("rate limits reset at the next window and remain isolated by client", () => {
  const policy = { bucket: "test-isolation", limit: 1, windowSeconds: 10 };

  assert.equal(consumeLocalRateLimit("client-a", policy, 1_000).allowed, true);
  assert.equal(consumeLocalRateLimit("client-a", policy, 2_000).allowed, false);
  assert.equal(consumeLocalRateLimit("client-b", policy, 2_000).allowed, true);
  assert.equal(consumeLocalRateLimit("client-a", policy, 10_000).allowed, true);
});
