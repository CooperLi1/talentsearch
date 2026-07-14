import assert from "node:assert/strict";
import test from "node:test";

import { mergePersonObservation } from "@/lib/discovery/enrichment";

test("provider enrichment upgrades a handle to a verified human name in the same pass", () => {
  const current = {
    displayName: "xiaoms22",
    identities: [{
      provider: "github" as const,
      externalId: "42",
      username: "xiaoms22",
      verified: true,
    }],
    sourceUrl: "https://github.com/xiaoms22",
  };
  const merged = mergePersonObservation(current, {
    ...current,
    displayName: "Mingshuo Xiao",
    websiteUrl: "https://xiaoms22.github.io/",
  });

  assert.equal(merged.displayName, "Mingshuo Xiao");
  assert.equal(merged.websiteUrl, "https://xiaoms22.github.io/");
});
