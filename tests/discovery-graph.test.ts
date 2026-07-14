import assert from "node:assert/strict";

import { expandDiscoveryGraph, graphEdgesToCandidateEvents } from "../lib/discovery/graph";
import type {
  DiscoveryConnector,
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
      edge({ relation: "collaborates_with", weight: 0.48, sourceUrl: "https://example.test/repo-a" }),
      edge({ relation: "collaborates_with", weight: 0.48, sourceUrl: "https://example.test/repo-b" }),
    ],
    now,
  }).length,
  1,
  "repeated public collaboration with a strong seed qualifies",
);

assert.equal(
  graphEdgesToCandidateEvents({
    edges: [
      edge({ relation: "engages_with", weight: 0.2, sourceUrl: "https://example.test/thread-1" }),
      edge({ relation: "engages_with", weight: 0.2, sourceUrl: "https://example.test/thread-2" }),
      edge({ relation: "engages_with", weight: 0.2, sourceUrl: "https://example.test/thread-3" }),
    ],
    now,
  }).length,
  0,
  "a handful of ordinary interactions must not qualify",
);

assert.equal(
  graphEdgesToCandidateEvents({
    edges: [
      edge({ relation: "engages_with", weight: 0.2, sourceUrl: "https://example.test/thread-1" }),
      edge({ relation: "engages_with", weight: 0.2, sourceUrl: "https://example.test/thread-2" }),
      edge({ relation: "engages_with", weight: 0.2, sourceUrl: "https://example.test/thread-3" }),
      edge({ relation: "engages_with", weight: 0.2, sourceUrl: "https://example.test/thread-4" }),
    ],
    now,
  }).length,
  1,
  "repeated substantive interaction can qualify without popularity metrics",
);

const nameOnlyTarget: PersonObservation = {
  displayName: "Same Name",
  identities: [],
  sourceUrl: "https://example.test/name-only",
};
assert.equal(
  graphEdgesToCandidateEvents({
    edges: [edge({ target: nameOnlyTarget, weight: 0.99 })],
    now,
  }).length,
  0,
  "a display name is never a durable graph identity",
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

const expandedHandles: string[] = [];
const graphConnector: DiscoveryConnector = {
  kind: "github",
  displayName: "Test GitHub",
  async discover() {
    return { events: [] };
  },
  async expandGraph(context) {
    const source = context.person.identities[0];
    expandedHandles.push(source.externalId);
    if (source.externalId !== "seed") return [];
    return [
      edge({ sourceId: "seed", target: person("weak-neighbor"), weight: 0.25 }),
      edge({ sourceId: "seed", target: person("strong-neighbor"), weight: 0.82 }),
    ];
  },
};
async function checkBoundedExpansion() {
  const expansion = await expandDiscoveryGraph({
    seeds: [person("seed")],
    connectors: new Map([["github", graphConnector]]),
    settings: { github: { enabled: true, maxItems: 10 } },
    maxDepth: 2,
    maxNodes: 10,
    now,
  });
  assert.equal(expansion.edges.length, 2);
  assert.deepEqual(
    expandedHandles,
    ["seed", "strong-neighbor"],
    "weak one-hop follows are evidence, but must not become recursive expansion seeds",
  );
  const surfaced = graphEdgesToCandidateEvents({ edges: expansion.edges, now });
  assert.equal(surfaced.length, 1, "a qualified adjacent person enters normal candidate events");
  assert.equal(surfaced[0].person.identities[0].externalId, "strong-neighbor");
  assert.equal(
    Array.isArray(surfaced[0].raw?.graphPath),
    true,
    "the surfaced candidate retains an auditable public graph path",
  );

  const bounded = await expandDiscoveryGraph({
    seeds: [person("seed")],
    connectors: new Map([["github", graphConnector]]),
    settings: { github: { enabled: true, maxItems: 10 } },
    maxDepth: 1,
    maxNodes: 10,
    maxEdgesPerSeed: 1,
    now,
  });
  assert.equal(bounded.edges.length, 1, "per-seed expansion has a hard edge budget");
}

checkBoundedExpansion().then(() => console.log("discovery graph checks passed"));
