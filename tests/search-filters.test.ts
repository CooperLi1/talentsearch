import assert from "node:assert/strict";
import test from "node:test";

import { nullableSearchFilter } from "../lib/search/filters";

test("nullableSearchFilter treats an empty selection as no database filter", () => {
  assert.equal(nullableSearchFilter(undefined), null);
  assert.equal(nullableSearchFilter([]), null);
  assert.deepEqual(nullableSearchFilter(["robotics"]), ["robotics"]);
});
