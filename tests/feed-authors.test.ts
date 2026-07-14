import assert from "node:assert/strict";
import test from "node:test";

import {
  extractFeedAuthors,
  interleaveFeedResults,
} from "../lib/discovery/connectors/feed";

test("feed author extraction emits distinct people and rejects publisher bylines", () => {
  assert.deepEqual(
    extractFeedAuthors({
      author: { name: "Ada Lovelace" },
      creator: [
        { "#text": "Grace Hopper" },
        "grace hopper",
        "GitHub Staff",
        "Cloudflare",
      ],
      contributor: ["The GitLab Team", { name: "李明" }],
    }),
    ["Ada Lovelace", "Grace Hopper", "李明"],
  );
});

test("feed author extraction has a hard per-entry fan-out cap", () => {
  const authors = extractFeedAuthors({
    creator: Array.from({ length: 12 }, (_, index) => `Author ${index + 1}`),
  });
  assert.equal(authors.length, 8);
  assert.equal(authors[0], "Author 1");
  assert.equal(authors[7], "Author 8");
});

test("feed results are interleaved fairly and stop at the global cap", () => {
  assert.deepEqual(
    interleaveFeedResults(
      [
        ["feed-a-1", "feed-a-2", "feed-a-3", "feed-a-4"],
        ["feed-b-1"],
        ["feed-c-1", "feed-c-2", "feed-c-3"],
      ],
      6,
    ),
    ["feed-a-1", "feed-b-1", "feed-c-1", "feed-a-2", "feed-c-2", "feed-a-3"],
  );
});
