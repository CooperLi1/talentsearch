import assert from "node:assert/strict";
import test from "node:test";

import {
  isModelProviderUnavailable,
  modelCallFailure,
  ModelProviderUnavailableError,
} from "../lib/ai/model-call-error";

test("model call errors expose nested quota failures without provider bodies", () => {
  const failure = modelCallFailure({
    name: "AI_RetryError",
    errors: [
      {
        name: "AI_APICallError",
        statusCode: 429,
        responseBody: JSON.stringify({
          error: {
            code: "insufficient_quota",
            message: "sensitive provider detail",
          },
        }),
      },
    ],
  });

  assert.deepEqual(failure, {
    name: "AI_RetryError",
    statusCode: 429,
    code: "insufficient_quota",
  });
  assert.equal(isModelProviderUnavailable(failure), true);
  assert.equal(
    new ModelProviderUnavailableError(failure).message,
    "Candidate brief model provider is unavailable (429 insufficient_quota)",
  );
});

test("ordinary rate limiting remains retryable", () => {
  const failure = modelCallFailure({
    name: "AI_APICallError",
    statusCode: 429,
    responseBody: JSON.stringify({
      error: { code: "rate_limit_exceeded" },
    }),
  });

  assert.equal(isModelProviderUnavailable(failure), false);
});

test("authentication and gateway budget failures are provider outages", () => {
  assert.equal(
    isModelProviderUnavailable({
      name: "AI_APICallError",
      statusCode: 401,
      code: null,
    }),
    true,
  );
  assert.equal(
    isModelProviderUnavailable({
      name: "AI_APICallError",
      statusCode: 402,
      code: null,
    }),
    true,
  );
});
