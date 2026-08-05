import assert from "node:assert/strict";
import test from "node:test";

import {
  applyIdentityMatchPolicy,
  type IdentityMatchOutput,
} from "../lib/ai/identity-match";

function output(overrides: Partial<IdentityMatchOutput> = {}): IdentityMatchOutput {
  return {
    verdict: "match",
    confidence: 0.88,
    corroboratingSignals: [
      {
        category: "education",
        candidateEvidence: "Studied at Example University",
        observedEvidence: "Example University student profile",
      },
      {
        category: "project",
        candidateEvidence: "Built the Atlas compiler",
        observedEvidence: "Atlas compiler author",
      },
    ],
    conflicts: [],
    summary: "The education and project history align.",
    ...overrides,
  };
}

test("independent education and project overlap can approve an identity match", () => {
  assert.equal(applyIdentityMatchPolicy(output()).decision, "match");
});

test("name and country alone remain reviewable rather than auto-matching", () => {
  const decision = applyIdentityMatchPolicy(output({
    confidence: 0.93,
    corroboratingSignals: [
      {
        category: "name",
        candidateEvidence: "Alex Kim",
        observedEvidence: "Alex Kim",
      },
      {
        category: "location",
        candidateEvidence: "China",
        observedEvidence: "China",
      },
    ],
  }));
  assert.equal(decision.decision, "review");
});

test("a concrete conflict prevents automatic matching", () => {
  const decision = applyIdentityMatchPolicy(output({
    confidence: 0.97,
    conflicts: [{
      category: "timeline",
      candidateEvidence: "Attended School A in 2025",
      observedEvidence: "Attended School B in 2025",
    }],
  }));
  assert.equal(decision.decision, "review");
});

test("the model can explicitly reject evidence for a different person", () => {
  assert.equal(applyIdentityMatchPolicy(output({ verdict: "reject" })).decision, "reject");
});
