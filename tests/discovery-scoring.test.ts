import assert from "node:assert/strict";
import test from "node:test";

import { evidencePublisherCount } from "../lib/discovery/evidence-publishers";
import { scoreCandidate } from "../lib/discovery/scoring";
import type { DiscoveryEvent } from "../lib/discovery/types";

function event(index: number, overrides: Partial<DiscoveryEvent> = {}): DiscoveryEvent {
  return {
    idempotencyKey: `event-${index}`,
    source: "github",
    sourceExternalId: `repo-${index}`,
    type: "project_created",
    title: `Built project ${index}`,
    occurredAt: "2026-07-01T00:00:00.000Z",
    discoveredAt: "2026-07-02T00:00:00.000Z",
    sourceUrl: `https://github.com/example/repo-${index}`,
    evidence: [{ label: "Repository", url: `https://github.com/example/repo-${index}` }],
    person: { displayName: "Example", identities: [], sourceUrl: "https://github.com/example" },
    confidence: 0.95,
    ...overrides,
  };
}

test("many shallow repositories do not max out originality or velocity", () => {
  const score = scoreCandidate({
    events: Array.from({ length: 12 }, (_, index) => event(index)),
    now: new Date("2026-07-12T00:00:00.000Z"),
  });

  assert.ok(score.features.projectOriginality < 0.3);
  assert.ok(score.features.trajectoryVelocity < 0.5);
});

test("inspectable technical depth materially raises project quality", () => {
  const shallow = scoreCandidate({ events: [event(1)] });
  const deep = scoreCandidate({
    events: [event(1, { metrics: { technicalComplexity: 0.85, technicalComplexityConfidence: 0.9 } })],
  });

  assert.ok(deep.features.technicalComplexity > 0.7);
  assert.ok(deep.features.projectOriginality > shallow.features.projectOriginality + 0.4);
});

test("profile observations do not create trajectory velocity", () => {
  const score = scoreCandidate({
    events: Array.from({ length: 10 }, (_, index) => event(index, {
      type: "profile_observed",
      sourceUrl: `https://example.com/profile/${index}`,
    })),
    now: new Date("2026-07-12T00:00:00.000Z"),
  });

  assert.equal(score.features.trajectoryVelocity, 0);
});

test("a search connector pointing to GitHub does not create source diversity", () => {
  const locatedGitHub = scoreCandidate({
    events: [
      event(1),
      event(2, {
        source: "brave-enrichment",
        sourceUrl: "https://github.com/example/second-project",
      }),
    ],
  });
  const independentPublisher = scoreCandidate({
    events: [
      event(1),
      event(2, {
        source: "brave-enrichment",
        sourceUrl: "https://example.dev/second-project",
      }),
    ],
  });

  assert.ok(locatedGitHub.features.evidenceDiversity < 0.5);
  assert.ok(independentPublisher.features.evidenceDiversity >= 0.5);
});

test("low-confidence locator matches do not count as evidence publishers", () => {
  const events = [
    event(1, { source: "github", sourceUrl: "https://github.com/example/project", confidence: 0.9 }),
    event(2, { source: "brave-enrichment", sourceUrl: "https://example.org/profile", confidence: 0.55 }),
  ];

  assert.equal(evidencePublisherCount(events), 1);
});
