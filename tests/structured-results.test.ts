import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeStructuredRecognition,
  parseStructuredPlacement,
  structuredResultTitle,
} from "../lib/discovery/connectors/structured-results";

test("structured result placement parsing accepts ranks but rejects scores and ranges", () => {
  assert.equal(parseStructuredPlacement("27"), 27);
  assert.equal(parseStructuredPlacement("Rank 27th"), 27);
  assert.equal(parseStructuredPlacement("T27"), 27);
  assert.equal(parseStructuredPlacement("27 (tied)"), 27);
  assert.equal(parseStructuredPlacement("27/42"), undefined);
  assert.equal(parseStructuredPlacement("35 points"), undefined);
  assert.equal(parseStructuredPlacement("Gold medal"), undefined);
  assert.equal(parseStructuredPlacement(""), undefined);
});

test("structured result recognition normalizes official medal abbreviations", () => {
  assert.equal(normalizeStructuredRecognition("G"), "gold medal");
  assert.equal(normalizeStructuredRecognition("Silver medal"), "silver medal");
  assert.equal(normalizeStructuredRecognition("HM"), "honorable mention");
  assert.equal(normalizeStructuredRecognition("Finalist"), undefined);
});

test("structured result titles lead with awards and retain rank only as fallback", () => {
  assert.equal(
    structuredResultTitle({
      name: "Aleksij Tasikj",
      eventName: "International Mathematical Olympiad 2025",
      placement: 27,
      recognition: "gold medal",
    }),
    "Aleksij Tasikj received a gold medal at International Mathematical Olympiad 2025",
  );
  assert.equal(
    structuredResultTitle({
      name: "Ada Lovelace",
      eventName: "Example Competition",
      recognition: "honorable mention",
    }),
    "Ada Lovelace received an honorable mention at Example Competition",
  );
  assert.equal(
    structuredResultTitle({
      name: "Grace Hopper",
      eventName: "Example Competition",
      placement: 4,
    }),
    "Grace Hopper placed 4 in Example Competition",
  );
});
