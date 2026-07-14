import assert from "node:assert/strict";
import test from "node:test";

import { sourceUpdateSchema } from "../app/api/_lib/schemas";

test("source configuration accepts bounded operator-editable settings", () => {
  const parsed = sourceUpdateSchema.parse({
    id: 3,
    config: {
      queries: ["robotics", "compiler construction"],
      lookbackDays: 14,
      maxItems: 35,
      options: { complexityKeywords: ["embedded systems", "formal verification"] },
    },
  });

  assert.ok("config" in parsed);
});

test("source configuration rejects credentials and unknown options", () => {
  assert.throws(() =>
    sourceUpdateSchema.parse({
      id: 3,
      config: { options: { apiKey: "must-not-be-stored-in-source-config" } },
    }),
  );
});

test("source configuration rejects local and private URLs", () => {
  for (const url of [
    "http://localhost:3000/feed.xml",
    "http://127.0.0.1/feed.xml",
    "http://10.0.0.4/feed.xml",
    "http://[::1]/feed.xml",
    "http://metadata.google.internal/latest/meta-data",
  ]) {
    assert.throws(
      () => sourceUpdateSchema.parse({ id: 4, config: { urls: [url] } }),
      `Expected ${url} to be rejected`,
    );
  }
});

test("structured source pages require safe selectors", () => {
  assert.doesNotThrow(() =>
    sourceUpdateSchema.parse({
      id: 5,
      config: {
        options: {
          pages: [
            {
              url: "https://example.org/results",
              itemSelector: ".result-row",
              nameSelector: ".participant",
              occurredAt: "2025-07-20",
            },
          ],
        },
      },
    }),
  );
  assert.throws(() =>
    sourceUpdateSchema.parse({
      id: 5,
      config: {
        options: {
          pages: [
            {
              url: "https://example.org/results",
              itemSelector: "article:has(a)",
              nameSelector: ".participant",
            },
          ],
        },
      },
    }),
  );
});

test("manual LinkedIn imports accept only member profile URLs", () => {
  assert.doesNotThrow(() =>
    sourceUpdateSchema.parse({
      id: 6,
      config: {
        options: {
          profiles: [
            {
              name: "Example Person",
              profileUrl: "https://www.linkedin.com/in/example-person",
              provenanceUrl: "https://example.edu/people/example-person",
              reviewed: true,
            },
          ],
        },
      },
    }),
  );
  assert.throws(() =>
    sourceUpdateSchema.parse({
      id: 6,
      config: {
        options: {
          profiles: [
            { name: "Example Person", profileUrl: "https://example.org/example-person", reviewed: true },
          ],
        },
      },
    }),
  );
  assert.throws(() =>
    sourceUpdateSchema.parse({
      id: 6,
      config: {
        options: {
          profiles: [
            { name: "Example Person", profileUrl: "https://www.linkedin.com/in/example-person" },
          ],
        },
      },
    }),
  );
});
