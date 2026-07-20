import assert from "node:assert/strict";
import test from "node:test";

import { getDefaultConnectorSettings, parseDiscoveryConfiguration } from "../lib/discovery/config";
import { createConnectorRegistry } from "../lib/discovery/connectors";
import {
  namesRoughlyMatch,
  parseLicensedProfile,
  PeopleDataLabsConnector,
} from "../lib/discovery/connectors/people-data-labs";
import type { ConnectorEnrichmentContext } from "../lib/discovery/types";

const now = new Date("2026-07-19T12:00:00.000Z");

function enrichmentContext(overrides?: Partial<ConnectorEnrichmentContext>): ConnectorEnrichmentContext {
  return {
    now,
    person: {
      displayName: "Reviewed Person",
      identities: [
        { provider: "github", externalId: "1234", username: "reviewed", verified: true },
      ],
      affiliations: ["Example University"],
      sourceUrl: "https://github.com/reviewed",
    },
    settings: { enabled: true, maxItems: 5, options: { minLikelihood: 8 } },
    ...overrides,
  };
}

test("People Data Labs stays registered but disabled without a key", () => {
  assert.ok(createConnectorRegistry().has("people-data-labs"));
  const previous = process.env.PEOPLE_DATA_SEARCH_KEY;
  delete process.env.PEOPLE_DATA_SEARCH_KEY;
  try {
    const settings = parseDiscoveryConfiguration({
      connectors: { "people-data-labs": { enabled: false } },
    }).connectors["people-data-labs"];
    assert.equal(settings?.enabled, false);
    assert.equal(getDefaultConnectorSettings()["people-data-labs"].maxItems, 5);
  } finally {
    if (previous !== undefined) process.env.PEOPLE_DATA_SEARCH_KEY = previous;
  }
});

test("a configured key enables licensed enrichment even when stored settings predate it", () => {
  const previous = process.env.PEOPLE_DATA_SEARCH_KEY;
  process.env.PEOPLE_DATA_SEARCH_KEY = "test-key";
  try {
    const settings = parseDiscoveryConfiguration({
      connectors: { "people-data-labs": { enabled: false } },
    }).connectors["people-data-labs"];
    assert.equal(settings?.enabled, true);
  } finally {
    if (previous === undefined) delete process.env.PEOPLE_DATA_SEARCH_KEY;
    else process.env.PEOPLE_DATA_SEARCH_KEY = previous;
  }
});

test("enrichment stays inert without a key and never issues a request", async () => {
  const previous = process.env.PEOPLE_DATA_SEARCH_KEY;
  delete process.env.PEOPLE_DATA_SEARCH_KEY;
  try {
    assert.equal(await new PeopleDataLabsConnector().enrich(enrichmentContext()), null);
  } finally {
    if (previous !== undefined) process.env.PEOPLE_DATA_SEARCH_KEY = previous;
  }
});

test("fuzzy lookups require a human name plus an affiliation or location anchor", async () => {
  const previous = process.env.PEOPLE_DATA_SEARCH_KEY;
  process.env.PEOPLE_DATA_SEARCH_KEY = "test-key";
  try {
    const connector = new PeopleDataLabsConnector();
    const singleToken = enrichmentContext();
    singleToken.person = { ...singleToken.person, displayName: "reviewed" };
    assert.equal(await connector.enrich(singleToken), null);

    const noAnchor = enrichmentContext();
    noAnchor.person = { ...noAnchor.person, affiliations: [], location: undefined };
    assert.equal(await connector.enrich(noAnchor), null);
  } finally {
    if (previous === undefined) delete process.env.PEOPLE_DATA_SEARCH_KEY;
    else process.env.PEOPLE_DATA_SEARCH_KEY = previous;
  }
});

test("a recent licensed event suppresses a second billed lookup", async () => {
  const previous = process.env.PEOPLE_DATA_SEARCH_KEY;
  process.env.PEOPLE_DATA_SEARCH_KEY = "test-key";
  try {
    const context = enrichmentContext({
      evidenceEvents: [
        {
          idempotencyKey: "existing",
          source: "people-data-labs",
          sourceExternalId: "existing",
          type: "profile_observed",
          title: "Reviewed Person's licensed work history was imported",
          occurredAt: "2026-07-01T00:00:00.000Z",
          discoveredAt: "2026-07-01T00:00:00.000Z",
          sourceUrl: "https://www.linkedin.com/in/reviewed-person",
          evidence: [],
          person: enrichmentContext().person,
          confidence: 0.9,
        },
      ],
    });
    assert.equal(await new PeopleDataLabsConnector().enrich(context), null);
  } finally {
    if (previous === undefined) delete process.env.PEOPLE_DATA_SEARCH_KEY;
    else process.env.PEOPLE_DATA_SEARCH_KEY = previous;
  }
});

test("licensed profiles parse only professional-history fields", () => {
  const profile = parseLicensedProfile({
    full_name: "Reviewed Person",
    job_title: "Robotics Engineer",
    job_company_name: "Example Robotics",
    location_name: "San Francisco, California",
    linkedin_url: "https://linkedin.com/in/reviewed-person/?trk=api",
    summary: "Builds autonomy stacks.",
    experience: [
      {
        company: { name: "Example Robotics" },
        title: { name: "Robotics Engineer" },
        start_date: "2024-02",
      },
      { company: { name: "Example University" }, title: { name: "Research Assistant" }, start_date: "2022-01", end_date: "2024-01" },
    ],
    education: [
      { school: { name: "Example University" }, degrees: ["BS Computer Science"], start_date: "2018", end_date: "2022" },
    ],
    skills: ["ros", "slam"],
  });
  assert.equal(profile?.headline, "Robotics Engineer at Example Robotics");
  assert.equal(profile?.linkedInUrl, "https://www.linkedin.com/in/reviewed-person");
  assert.deepEqual(profile?.experienceLines, [
    "Robotics Engineer at Example Robotics (2024–present)",
    "Research Assistant at Example University (2022–2024)",
  ]);
  assert.deepEqual(profile?.educationLines, ["BS Computer Science at Example University (2018–2022)"]);
  assert.ok(profile?.affiliations.includes("Example University"));
  assert.equal(parseLicensedProfile({}), null);
});

test("fuzzy-match name correspondence tolerates ordering but rejects other people", () => {
  assert.equal(namesRoughlyMatch("Reviewed Person", "Person, Reviewed"), true);
  assert.equal(namesRoughlyMatch("Reviewed Q. Person", "Reviewed Person"), true);
  assert.equal(namesRoughlyMatch("Somebody Else", "Reviewed Person"), false);
  assert.equal(namesRoughlyMatch("", "Reviewed Person"), false);
});

test("verified licensed profiles reach briefs; fuzzy matches stay excluded", async () => {
  const { isLicensedProfileBriefEvent, isSubstantiveBriefEvent, isCandidateIntroductionEvidence } =
    await import("../lib/ai/summaries");
  const base = {
    idempotencyKey: "licensed",
    source: "people-data-labs" as const,
    sourceExternalId: "licensed",
    type: "profile_observed" as const,
    title: "Reviewed Person's licensed work history was imported",
    description: "Work history: Robotics Engineer at Example Robotics (2024–present); Education: BS at Example University",
    occurredAt: "2026-07-19T00:00:00.000Z",
    discoveredAt: "2026-07-19T00:00:00.000Z",
    sourceUrl: "https://www.linkedin.com/in/reviewed-person",
    evidence: [],
    person: { displayName: "Reviewed Person", identities: [], sourceUrl: "https://www.linkedin.com/in/reviewed-person" },
    confidence: 0.92,
    tags: ["licensed-data", "verified-provider-subject"],
  };
  assert.equal(isLicensedProfileBriefEvent(base), true);
  assert.equal(isSubstantiveBriefEvent(base), true);
  assert.equal(isCandidateIntroductionEvidence(base), true);
  const fuzzy = { ...base, confidence: 0.75, tags: ["licensed-data", "requires-corroboration"] };
  assert.equal(isLicensedProfileBriefEvent(fuzzy), false);
  assert.equal(isSubstantiveBriefEvent(fuzzy), false);
});
