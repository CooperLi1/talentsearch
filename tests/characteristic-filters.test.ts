import assert from "node:assert/strict";
import test from "node:test";

import {
  candidatePassesRequiredCharacteristics,
  evaluateCandidateCharacteristics,
  mergeCriterionCharacteristics,
} from "../lib/criteria/characteristics";
import type { Candidate } from "../lib/domain/types";

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: "1",
    workspaceId: "1",
    slug: "example",
    name: "Example Person",
    initials: "EP",
    headline: "",
    location: "",
    stage: "High school student",
    school: "Example High School",
    affiliations: [],
    domains: [],
    score: 30,
    momentum: 0,
    confidence: 0.9,
    confidenceBand: "high",
    status: "new",
    summaryMarkdown: "",
    whyNowMarkdown: "",
    earlynessMarkdown: "",
    latestEvent: null,
    events: [],
    identities: [],
    contactRoutes: [],
    connections: [],
    sourceCount: 1,
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    scoreComponents: {
      activityVolume: 0.72,
      publicRecognition: 0.18,
    },
    ...overrides,
  };
}

test("matches explicit evidence characteristics without inferring age", () => {
  const input = candidate({
    events: [
      {
        id: "e1",
        candidateId: "1",
        type: "competition_result",
        title: "Example Person received a gold medal at IOI 2025",
        summaryMarkdown: "",
        whyItMattersMarkdown: "",
        occurredAt: "2025-01-01T00:00:00.000Z",
        discoveredAt: "2026-01-01T00:00:00.000Z",
        sourceLabel: "roster-page",
        sourceUrl: "https://stats.ioinformatics.org/results/2025",
        confidence: 0.9,
        novelty: 1,
        significance: 1,
        links: [],
      },
    ],
  });
  const matches = new Map(
    evaluateCandidateCharacteristics(input).map((match) => [
      match.key,
      match.matched,
    ]),
  );

  assert.equal(matches.get("explicitHighSchool"), true);
  assert.equal(matches.get("ioiRecognition"), true);
  assert.equal(matches.get("activeButUndiscovered"), true);
});

test("required deterministic characteristics exclude nonmatches", () => {
  const rules = mergeCriterionCharacteristics(undefined).map((rule) =>
    rule.key === "ioiRecognition"
      ? { ...rule, enabled: true, mode: "require" as const }
      : rule,
  );

  assert.equal(candidatePassesRequiredCharacteristics(candidate(), rules), false);
});
