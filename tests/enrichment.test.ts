import assert from "node:assert/strict";
import test from "node:test";

import { enrichPeople } from "../lib/discovery/enrichment";
import {
  candidateResearchQueries,
  hasCorroboratedPageIdentity,
  projectLocatorContext,
} from "../lib/discovery/connectors/brave-enrichment";
import { ownedWorkProfileFromHtml } from "../lib/discovery/connectors/web-presence";
import { crossProfileClaimForUrl } from "../lib/discovery/cross-profile-links";
import type {
  DiscoveryConnector,
  DiscoveryEvent,
  PersonObservation,
  SourceKind,
} from "../lib/discovery/types";

function event(source: SourceKind, person: PersonObservation): DiscoveryEvent {
  return {
    confidence: 0.95,
    discoveredAt: "2026-07-12T00:00:00.000Z",
    evidence: [{ label: source, url: person.sourceUrl }],
    idempotencyKey: `${source}:${person.identities.map((identity) => identity.provider).join(",")}`,
    occurredAt: "2026-07-12T00:00:00.000Z",
    person,
    source,
    sourceExternalId: `${source}-event`,
    sourceUrl: person.sourceUrl,
    title: `${source} profile`,
    type: "profile_observed",
  };
}

test("enrichment follows newly verified providers and websites in the same pass", async () => {
  const calls: Array<{ kind: SourceKind; person: PersonObservation }> = [];
  const initial: PersonObservation = {
    displayName: "Ada Example",
    identities: [{
      provider: "github",
      externalId: "123",
      username: "ada",
      verified: true,
    }],
    sourceUrl: "https://github.com/ada",
  };
  const connector = (
    kind: SourceKind,
    enrich: DiscoveryConnector["enrich"],
  ): DiscoveryConnector => ({
    displayName: kind,
    discover: async () => ({ events: [] }),
    enrich,
    kind,
  });
  const connectors = new Map<SourceKind, DiscoveryConnector>([
    ["github", connector("github", async ({ person }) => {
      calls.push({ kind: "github", person });
      const enriched = {
        ...person,
        websiteUrl: "https://ada.example",
        identities: [
          ...person.identities,
          { provider: "x" as const, externalId: "ada", username: "ada", verified: true },
        ],
      };
      return { events: [event("github", enriched)] };
    })],
    ["x", connector("x", async ({ person }) => {
      calls.push({ kind: "x", person });
      return { events: [event("x", person)] };
    })],
    ["web-presence", connector("web-presence", async ({ person }) => {
      calls.push({ kind: "web-presence", person });
      return { events: [event("web-presence", person)] };
    })],
    ["brave-enrichment", connector("brave-enrichment", async ({ person }) => {
      calls.push({ kind: "brave-enrichment", person });
      return { events: [event("brave-enrichment", person)] };
    })],
  ]);

  const result = await enrichPeople({
    connectors,
    people: [initial],
    settings: Object.fromEntries(
      [...connectors.keys()].map((kind) => [kind, { enabled: true }]),
    ),
  });

  assert.deepEqual(calls.map((call) => call.kind), [
    "github",
    "x",
    "web-presence",
    "brave-enrichment",
  ]);
  assert.equal(calls.at(-1)?.person.websiteUrl, "https://ada.example");
  assert.ok(calls.at(-1)?.person.identities.some((identity) => identity.provider === "x"));
  assert.equal(result.results[0]?.person.websiteUrl, "https://ada.example");
});

test("a verified DOI authorship bridge schedules Crossref enrichment", async () => {
  const person: PersonObservation = {
    displayName: "Ada Example",
    identities: [{
      provider: "doi-authorship",
      externalId: "10.1145/example.123#author-2",
      verified: true,
    }],
    sourceUrl: "https://doi.org/10.1145/example.123",
  };
  let calls = 0;
  await enrichPeople({
    people: [person],
    connectors: new Map([["crossref", {
      kind: "crossref",
      displayName: "Crossref",
      discover: async () => ({ events: [] }),
      enrich: async () => {
        calls += 1;
        return { events: [] };
      },
    }]]),
    settings: { crossref: { enabled: true } },
  });
  assert.equal(calls, 1);
});

test("public web enrichment receives prior evidence and newly observed provider events", async () => {
  const person: PersonObservation = {
    displayName: "Ada Example",
    identities: [{ provider: "github", externalId: "123", username: "ada", verified: true }],
    sourceUrl: "https://github.com/ada",
  };
  const prior = {
    ...event("github", person),
    idempotencyKey: "prior-project",
    sourceUrl: "https://github.com/ada/robot-arm",
    type: "project_created" as const,
  };
  let observedEvidence: DiscoveryEvent[] = [];
  const connectors = new Map<SourceKind, DiscoveryConnector>([
    ["github", {
      kind: "github",
      displayName: "GitHub",
      discover: async () => ({ events: [] }),
      enrich: async () => ({ events: [event("github", person)] }),
    }],
    ["brave-enrichment", {
      kind: "brave-enrichment",
      displayName: "Public web",
      discover: async () => ({ events: [] }),
      enrich: async ({ evidenceEvents }) => {
        observedEvidence = evidenceEvents ?? [];
        return { events: [] };
      },
    }],
  ]);

  await enrichPeople({
    connectors,
    people: [person],
    evidenceEvents: [[prior]],
    settings: {
      github: { enabled: true },
      "brave-enrichment": { enabled: true },
    },
  });

  assert.equal(observedEvidence.length, 2);
  assert.ok(observedEvidence.some((item) => item.idempotencyKey === "prior-project"));
  assert.deepEqual(projectLocatorContext(observedEvidence), [{
    name: "robot-arm",
    url: "https://github.com/ada/robot-arm",
  }]);
});

test("deep research rotates bounded query plans while retaining LinkedIn lookup", () => {
  const person: PersonObservation = {
    displayName: "Ada Example",
    identities: [{ provider: "github", externalId: "123", username: "ada", verified: true }],
    affiliations: ["Example Lab"],
    alternateNames: [{
      name: "Ada Lovelace Example",
      sourceUrl: "https://ada.example",
      confidence: 0.9,
      proof: "owned-page-author",
    }],
    sourceUrl: "https://github.com/ada",
  };
  const first = candidateResearchQueries({ person, maxQueries: 5, researchPass: 0 });
  const second = candidateResearchQueries({ person, maxQueries: 5, researchPass: 1 });
  const third = candidateResearchQueries({ person, maxQueries: 5, researchPass: 2 });
  assert.equal(first.length, 5);
  assert.equal(second.length, 5);
  assert.equal(third.length, 5);
  assert.ok(first.some((query) => query.includes("site:linkedin.com/in")));
  assert.ok(second.some((query) => query.includes("interview")));
  assert.ok(third.some((query) => query.includes("also known as")));
  assert.ok(third.some((query) => query.includes("Ada Lovelace Example")));
  assert.notDeepEqual(first, second);
  assert.notDeepEqual(second, third);
});

test("direct profile URLs become provider hypotheses without treating arbitrary pages as accounts", () => {
  assert.deepEqual(crossProfileClaimForUrl("https://github.com/ada-example"), {
    provider: "github",
    handle: "ada-example",
    profileUrl: "https://github.com/ada-example",
    proof: "profile-link",
  });
  assert.equal(crossProfileClaimForUrl("https://github.com/ada-example/project"), null);
  assert.equal(crossProfileClaimForUrl("https://example.com/about"), null);
});

test("an exact author name alone cannot bind an unrelated public page", () => {
  assert.equal(hasCorroboratedPageIdentity({
    nameMatch: true,
    affiliationMatch: false,
    matchedProject: false,
    linkedKnownProfile: false,
    sameKnownWebsite: false,
  }), false);
  assert.equal(hasCorroboratedPageIdentity({
    nameMatch: true,
    affiliationMatch: true,
    matchedProject: false,
    linkedKnownProfile: false,
    sameKnownWebsite: false,
  }), true);
  assert.equal(hasCorroboratedPageIdentity({
    nameMatch: true,
    affiliationMatch: false,
    matchedProject: false,
    linkedKnownProfile: true,
    sameKnownWebsite: false,
  }), true);
});

test("a verified personal homepage yields bounded work evidence without requiring an article date", () => {
  const profile = ownedWorkProfileFromHtml(`
    <html>
      <head>
        <title>Mingshuo Xiao</title>
        <meta name="description" content="Robotics research and real-world deployment" />
      </head>
      <body><main>Built a robot arm that learns pickup tasks from demonstrations.</main></body>
    </html>
  `);

  assert.equal(profile?.title, "Mingshuo Xiao");
  assert.match(profile?.description ?? "", /robot arm that learns pickup tasks/i);
  assert.equal(typeof profile?.contentHash, "string");
});

test("a personal homepage carries an explicitly stated role and affiliation into later research", () => {
  const profile = ownedWorkProfileFromHtml(`
    <html><head><title>Mingshuo Xiao</title></head><body><main>
      I am Mingshuo Xiao, an incoming direct PhD student at Tsinghua University.
      My research focuses on robots that learn from demonstrations.
    </main></body></html>
  `);

  assert.match(profile?.profileHeadline ?? "", /incoming direct PhD student/i);
  assert.deepEqual(profile?.affiliations, ["Tsinghua University"]);
});
