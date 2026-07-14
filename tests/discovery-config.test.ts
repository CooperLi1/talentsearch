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
import { OpenAlexConnector } from "../lib/discovery/connectors/openalex";

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
