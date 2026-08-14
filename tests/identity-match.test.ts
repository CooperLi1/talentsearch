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

test("one strong overlap can approve a confident identity match", () => {
  const strongOverlap = [{
    category: "work" as const,
    candidateEvidence: "Worked on the Atlas compiler at Example Labs",
    observedEvidence: "Atlas compiler engineer at Example Labs",
  }];
  assert.equal(applyIdentityMatchPolicy(output({
    confidence: 0.85,
    corroboratingSignals: strongOverlap,
  })).decision, "match");
  assert.equal(applyIdentityMatchPolicy(output({
    confidence: 0.84,
    corroboratingSignals: strongOverlap,
  })).decision, "review");
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

test("official roster candidates need more than a country match", () => {
  const decision = applyIdentityMatchPolicy(output({
    confidence: 0.78,
    corroboratingSignals: [
      {
        category: "name",
        candidateEvidence: "Hengxi Liu",
        observedEvidence: "Hengxi Liu",
      },
      {
        category: "location",
        candidateEvidence: "China",
        observedEvidence: "Beijing, China",
      },
    ],
  }), { officialRosterCandidate: true });
  assert.equal(decision.decision, "review");

  const educationMatch = applyIdentityMatchPolicy(output({
    confidence: 0.78,
    corroboratingSignals: [
      {
        category: "name",
        candidateEvidence: "Hengxi Liu",
        observedEvidence: "Hengxi Liu",
      },
      {
        category: "education",
        candidateEvidence: "Example School",
        observedEvidence: "Example School student profile",
      },
    ],
  }), { officialRosterCandidate: true });
  assert.equal(educationMatch.decision, "match");
});

test("official roster matching still refuses conflicts and name-only matches", () => {
  const nameOnly = applyIdentityMatchPolicy(output({
    confidence: 0.95,
    corroboratingSignals: [{
      category: "name",
      candidateEvidence: "Alex Kim",
      observedEvidence: "Alex Kim",
    }],
  }), { officialRosterCandidate: true });
  assert.equal(nameOnly.decision, "review");

  const broadInterestOnly = applyIdentityMatchPolicy(output({
    confidence: 0.95,
    corroboratingSignals: [
      {
        category: "name",
        candidateEvidence: "Alex Kim",
        observedEvidence: "Alex Kim",
      },
      {
        category: "interests",
        candidateEvidence: "Interested in programming",
        observedEvidence: "Interested in software",
      },
    ],
  }), { officialRosterCandidate: true });
  assert.equal(broadInterestOnly.decision, "review");

  const conflicting = applyIdentityMatchPolicy(output({
    confidence: 0.95,
    corroboratingSignals: [{
      category: "education",
      candidateEvidence: "School A",
      observedEvidence: "School A",
    }],
    conflicts: [{
      category: "timeline",
      candidateEvidence: "Competed as a student in 2025",
      observedEvidence: "Retired in 2010",
    }],
  }), { officialRosterCandidate: true });
  assert.equal(conflicting.decision, "review");
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
