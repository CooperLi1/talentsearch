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
  const rules = [
    {
      key: "explicitHighSchool",
      label: "Explicitly in high school",
      description: "",
      enabled: true,
      mode: "prefer" as const,
    },
    {
      key: "ioiRecognition",
      label: "IOI recognition",
      description: "",
      enabled: true,
      mode: "prefer" as const,
    },
    {
      key: "activeButUndiscovered",
      label: "Active but undiscovered",
      description: "",
      enabled: true,
      mode: "prefer" as const,
    },
  ];
  const matches = new Map(
    evaluateCandidateCharacteristics(input, rules).map((match) => [
      match.key,
      match.matched,
    ]),
  );

  assert.equal(matches.get("explicitHighSchool"), true);
  assert.equal(matches.get("ioiRecognition"), true);
  assert.equal(matches.get("activeButUndiscovered"), true);
});

test("starts with no evidence characteristics", () => {
  assert.deepEqual(mergeCriterionCharacteristics(undefined), []);
  assert.deepEqual(evaluateCandidateCharacteristics(candidate()), []);
});

test("custom characteristics can match all or any operator-defined evidence terms", () => {
  const input = candidate({
    headline: "Robotics builder",
    biography: "Built an autonomous rover while attending high school.",
  });
  const matches = evaluateCandidateCharacteristics(input, [
    {
      key: "custom_robotics_builder",
      label: "High-school robotics builder",
      description: "",
      enabled: true,
      mode: "prefer",
      evidenceMatch: "all",
      values: ["high school", "autonomous rover"],
    },
    {
      key: "custom_competition",
      label: "Competition experience",
      description: "",
      enabled: true,
      mode: "prefer",
      evidenceMatch: "any",
      values: ["IOI", "robotics"],
    },
  ]);

  assert.deepEqual(matches.map((match) => match.matched), [true, true]);
});

test("custom evidence terms match whole words rather than substrings", () => {
  const matches = evaluateCandidateCharacteristics(
    candidate({ biography: "Started a robotics company." }),
    [
      {
        key: "custom_art",
        label: "Art",
        description: "",
        enabled: true,
        mode: "prefer",
        evidenceMatch: "all",
        values: ["art"],
      },
    ],
  );

  assert.equal(matches[0]?.matched, false);
});

test("required custom characteristics exclude nonmatches", () => {
  const rules = [
    {
      key: "custom_ioi_winner",
      label: "IOI winner",
      description: "",
      enabled: true,
      mode: "require" as const,
      evidenceMatch: "all" as const,
      values: ["IOI", "winner"],
    },
  ];

  assert.equal(candidatePassesRequiredCharacteristics(candidate(), rules), false);
});
