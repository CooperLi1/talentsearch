import assert from "node:assert/strict";
import test from "node:test";

import { isSelfAttributedShowHn } from "@/lib/discovery/connectors/hacker-news";

test("Hacker News submissions require a first-person build claim for authorship", () => {
  assert.equal(isSelfAttributedShowHn({
    title: "Show HN: A small robot",
    text: "We built this robot to sort recycling.",
  }), true);
  assert.equal(isSelfAttributedShowHn({
    title: "Show HN: A small robot",
    text: "An interesting robot project from another team.",
  }), false);
  assert.equal(isSelfAttributedShowHn({
    title: "A small robot",
    text: "I built this robot to sort recycling.",
  }), false);
  assert.equal(isSelfAttributedShowHn({
    title: "Show HN: A small robot",
  }), false);
  assert.equal(isSelfAttributedShowHn({
    title: "Show HN: A small robot",
    text: "I&#x27;m the author and have been working on this for a year.",
  }), true);
});
