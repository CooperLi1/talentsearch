import assert from "node:assert/strict";

import { graphEdgesToCandidateEvents } from "../lib/discovery/graph";
import type {
  ExternalIdentity,
  GraphEdge,
  PersonObservation,
} from "../lib/discovery/types";

const now = new Date("2026-07-10T12:00:00.000Z");

function identity(
  provider: ExternalIdentity["provider"],
  externalId: string,
): ExternalIdentity {
  return {
    provider,
    externalId,
    username: externalId,
    profileUrl: `https://example.test/${provider}/${externalId}`,
    verified: true,
  };
}

function person(externalId = "candidate-1"): PersonObservation {
  return {
    displayName: "Candidate One",
    identities: [
      identity("github", externalId),
      {
        provider: "email",
        externalId: "private@example.test",
        verified: true,
      },
    ],
    emailHash: "must-not-propagate",
    sourceUrl: `https://github.com/${externalId}`,
  };
}

function edge(input: {
  sourceId?: string;
  target?: PersonObservation;
  relation?: GraphEdge["relation"];
  weight?: number;
  sourceUrl?: string;
} = {}): GraphEdge {
  const sourceId = input.sourceId ?? "seed-1";
  return {
    source: identity("github", sourceId),
    target: input.target ?? person(),
    relation: input.relation ?? "follows",
    weight: input.weight ?? 0.35,
    sourceUrl: input.sourceUrl ?? `https://github.com/${sourceId}?tab=following`,
    observedAt: now.toISOString(),
  };
}

assert.equal(
  graphEdgesToCandidateEvents({ edges: [edge()], now }).length,
  0,
  "a single weak follow must not create a candidate event",
);

assert.equal(
  graphEdgesToCandidateEvents({ edges: [edge(), edge()], now }).length,
  0,
  "duplicating the same weak support must not manufacture corroboration",
);

const corroboratedEdges = [
  edge({ sourceId: "seed-1" }),
  edge({
    sourceId: "seed-2",
    relation: "engages_with",
    sourceUrl: "https://github.com/seed-2/activity",
  }),
];
const corroborated = graphEdgesToCandidateEvents({ edges: corroboratedEdges, now });
assert.equal(corroborated.length, 1);
assert.equal(corroborated[0].type, "social_graph_signal");
assert.equal(corroborated[0].evidence.length, 2);
assert.deepEqual(
  corroborated[0].tags,
  ["graph-discovery", "relation:engages_with", "relation:follows"],
);
assert.equal(
  corroborated[0].person.identities.some((item) => item.provider === "email"),
  false,
  "contact identities must not propagate into graph candidates",
);
assert.equal("emailHash" in corroborated[0].person, false);
assert.equal(
  corroborated[0].idempotencyKey,
  graphEdgesToCandidateEvents({ edges: [...corroboratedEdges].reverse(), now })[0]
    .idempotencyKey,
  "input order must not affect event identity",
);

assert.equal(
  graphEdgesToCandidateEvents({ edges: [edge({ weight: 0.82 })], now }).length,
  1,
  "one genuinely strong edge may qualify",
);

assert.equal(
  graphEdgesToCandidateEvents({
    edges: [edge({ relation: "coauthors_with", weight: 0.18 })],
    now,
  }).length,
  0,
  "one ordinary coauthor edge is not repeated evidence",
);
assert.equal(
  graphEdgesToCandidateEvents({
    edges: [edge({ relation: "coauthors_with", weight: 0.36 })],
    now,
  }).length,
  1,
  "an accumulated repeated-coauthor weight qualifies",
);

assert.equal(
  graphEdgesToCandidateEvents({
    edges: [
      edge({ target: person("candidate-1"), weight: 0.9 }),
      edge({ target: person("candidate-2"), weight: 0.9 }),
    ],
    now,
    maxCandidates: 1,
  }).length,
  1,
  "candidate output must remain bounded",
);

console.log("discovery graph checks passed");
