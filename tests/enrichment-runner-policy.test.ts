import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const runner = readFileSync(
  new URL("../lib/discovery/enrichment-runner.ts", import.meta.url),
  "utf8",
);

test("each enrichment shard refreshes the candidate it claimed", () => {
  assert.match(runner, /intelligenceRefreshLimit:\s*candidateLimit/);
  assert.doesNotMatch(runner, /intelligenceRefreshLimit:\s*0/);
});
