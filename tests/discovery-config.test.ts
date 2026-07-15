import assert from "node:assert/strict";
import test from "node:test";

import {
  getDefaultConnectorSettings,
  parseDiscoveryConfiguration,
  RECOMMENDED_CONNECTOR_QUERIES,
  RECOMMENDED_HACKER_NEWS_TOPICS,
  RECOMMENDED_TECHNICAL_COMPLEXITY_KEYWORDS,
  VERIFIED_TECHNICAL_FEEDS,
} from "../lib/discovery/config";
import {
  excludeForkedRepositories,
  githubPagesProfile,
  withGitHubLookback,
} from "../lib/discovery/connectors/github";
import {
  OpenAlexConnector,
  openAlexWorkEvents,
} from "../lib/discovery/connectors/openalex";
import {
  semanticScholarAuthorPerson,
  semanticScholarPaperEvents,
} from "../lib/discovery/connectors/semantic-scholar";
import {
  doiAuthorshipIdentity,
  normalizeDoi,
  parseDoiAuthorshipIdentity,
} from "../lib/discovery/doi";
import { normalizeOrcid } from "../lib/discovery/orcid";

test("recommended query sets fit the shared eight-query execution budget", () => {
  for (const [source, queries] of Object.entries(RECOMMENDED_CONNECTOR_QUERIES)) {
    assert.ok(queries.length > 0, `${source} should have at least one recommended query`);
    assert.ok(queries.length <= 8, `${source} exceeds the eight-query connector budget`);
    assert.equal(new Set(queries).size, queries.length, `${source} contains a duplicate query`);
  }
  assert.equal(RECOMMENDED_TECHNICAL_COMPLEXITY_KEYWORDS.length, 30);
  assert.ok(RECOMMENDED_HACKER_NEWS_TOPICS.length >= 15);
  assert.equal(VERIFIED_TECHNICAL_FEEDS.length, 5);
});

test("default connector settings carry every recommended query", () => {
  const defaults = getDefaultConnectorSettings();
  for (const [source, queries] of Object.entries(RECOMMENDED_CONNECTOR_QUERIES)) {
    assert.deepEqual(
      defaults[source as keyof typeof defaults].queries,
      queries,
      `${source} defaults drifted from the exported recommendations`,
    );
  }
  assert.deepEqual(
    defaults.github.options?.complexityKeywords,
    RECOMMENDED_TECHNICAL_COMPLEXITY_KEYWORDS,
  );
  assert.deepEqual(
    defaults["hacker-news"].options?.topicKeywords,
    RECOMMENDED_HACKER_NEWS_TOPICS,
  );
  assert.deepEqual(defaults["technical-blogs"].urls, VERIFIED_TECHNICAL_FEEDS);
});

test("configuration rejects query lists that a connector cannot fully execute", () => {
  assert.throws(
    () =>
      parseDiscoveryConfiguration({
        connectors: {
          github: {
            enabled: true,
            queries: Array.from({ length: 9 }, (_, index) => `topic-${index}`),
          },
        },
      }),
    /Too big|less than or equal to 8/i,
  );
});

test("GitHub applies the rolling lookback unless a query has an explicit date qualifier", () => {
  assert.equal(
    withGitHubLookback("compiler", "2026-06-28"),
    "compiler pushed:>=2026-06-28",
  );
  assert.equal(
    withGitHubLookback("robotics created:>=2026-07-01", "2026-06-28"),
    "robotics created:>=2026-07-01",
  );
});

test("GitHub enrichment does not attribute forks to the profile owner", () => {
  assert.deepEqual(
    excludeForkedRepositories([
      { name: "original", fork: false },
      { name: "upstream-copy", fork: true },
      { name: "legacy-original" },
    ]).map((repository) => repository.name),
    ["original", "legacy-original"],
  );
});

test("a personal GitHub Pages repository can recover an owned site and stated name", () => {
  assert.deepEqual(
    githubPagesProfile("xiaoms22", [{
      name: "xiaoms22.github.io",
      description: "Mingshuo Xiao personal homepage built with PRISM",
      homepage: "https://xiaoms22.github.io",
    }]),
    {
      websiteUrl: "https://xiaoms22.github.io/",
      displayName: "Mingshuo Xiao",
    },
  );
  assert.equal(
    githubPagesProfile("example", [{
      name: "someone-else.github.io",
      description: "Not the account site",
      homepage: null,
    }]),
    null,
  );
});

test("OpenAlex refuses to make a request without its server-side API key", async () => {
  const previous = process.env.OPENALEX_API_KEY;
  delete process.env.OPENALEX_API_KEY;
  try {
    const connector = new OpenAlexConnector();
    await assert.rejects(
      connector.discover({
        now: new Date("2026-07-12T12:00:00.000Z"),
        settings: {
          enabled: true,
          queries: ["robotics"],
          maxItems: 1,
          lookbackDays: 7,
        },
      }),
      /OPENALEX_API_KEY is required/,
    );
  } finally {
    if (previous === undefined) delete process.env.OPENALEX_API_KEY;
    else process.env.OPENALEX_API_KEY = previous;
  }
});

test("academic author profiles preserve durable ORCID and operator-useful context", () => {
  const person = semanticScholarAuthorPerson({
    authorId: "1741101",
    name: "Ada Example",
    aliases: ["A. Example", "Ada Example"],
    url: "https://www.semanticscholar.org/author/1741101",
    externalIds: { ORCID: "https://orcid.org/0000-0002-1825-0097" },
    affiliations: ["Example Robotics Lab"],
    homepage: "https://ada.example/research",
  }, "https://www.semanticscholar.org/author/1741101");

  assert.deepEqual(person.identities.map((identity) => identity.provider), [
    "semantic-scholar",
    "orcid",
  ]);
  assert.equal(person.identities[1]?.externalId, "0000-0002-1825-0097");
  assert.deepEqual(person.affiliations, ["Example Robotics Lab"]);
  assert.deepEqual(person.alternateNames?.map((item) => item.name), ["A. Example"]);
  assert.equal(person.websiteUrl, "https://ada.example/research");
});

test("Semantic Scholar enrichment emits only the requested author", () => {
  const events = semanticScholarPaperEvents({
    paperId: "paper-1",
    title: "A collaborative paper",
    externalIds: { DOI: "10.1000/example" },
    authors: [
      { authorId: "target-1", name: "Target Author" },
      { authorId: "coauthor-2", name: "Other Author" },
    ],
  }, new Date("2026-07-15T12:00:00.000Z"), "target-1");

  assert.deepEqual(events.map((event) => event.person.displayName), ["Target Author"]);
  assert.equal(events[0]?.person.identities[1]?.externalId, "10.1000/example#author-0");
});

test("OpenAlex enrichment emits only the requested author", () => {
  const events = openAlexWorkEvents({
    id: "https://openalex.org/W1",
    display_name: "A collaborative paper",
    authorships: [
      { author: { id: "https://openalex.org/A1", display_name: "Target Author" } },
      { author: { id: "https://openalex.org/A2", display_name: "Other Author" } },
    ],
  }, new Date("2026-07-15T12:00:00.000Z"), "A1");

  assert.deepEqual(events.map((event) => event.person.displayName), ["Target Author"]);
});

test("ORCID normalization rejects malformed and checksum-invalid identifiers", () => {
  assert.equal(normalizeOrcid("http://orcid.org/0000-0002-1825-0097"), "0000-0002-1825-0097");
  assert.equal(normalizeOrcid("0000-0002-1825-0098"), undefined);
  assert.equal(normalizeOrcid("not-an-orcid"), undefined);
});

test("DOI authorship identities join scholarly indexes without name matching", () => {
  assert.equal(normalizeDoi("https://doi.org/10.1145/Example.123"), "10.1145/example.123");
  assert.deepEqual(doiAuthorshipIdentity("10.1145/Example.123", 2), {
    provider: "doi-authorship",
    externalId: "10.1145/example.123#author-2",
    profileUrl: "https://doi.org/10.1145/example.123",
    verified: true,
    confidence: 0.98,
    proof: "provider-api",
    proofSourceUrl: "https://doi.org/10.1145/example.123",
  });
  assert.equal(doiAuthorshipIdentity("not-a-doi", 0), undefined);
  assert.deepEqual(parseDoiAuthorshipIdentity("10.1145/example.123#author-2"), {
    doi: "10.1145/example.123",
    authorIndex: 2,
  });
  assert.equal(parseDoiAuthorshipIdentity("10.1145/example.123#author-nope"), undefined);
});
