import assert from "node:assert/strict";
import test from "node:test";

import { getDefaultConnectorSettings, parseDiscoveryConfiguration } from "../lib/discovery/config";
import { createConnectorRegistry } from "../lib/discovery/connectors";
import {
  licensedFuzzyLookupAnchor,
  isGroundedRosterLicensedMatch,
  namesRoughlyMatch,
  parseLicensedProfile,
  PeopleDataLabsConnector,
  shouldBindLicensedProfileIdentity,
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
    assert.equal(getDefaultConnectorSettings()["people-data-labs"].options?.minLikelihood, 6);
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
  const previousFuzzy = process.env.PDL_ALLOW_FUZZY_LOOKUPS;
  process.env.PEOPLE_DATA_SEARCH_KEY = "test-key";
  process.env.PDL_ALLOW_FUZZY_LOOKUPS = "true";
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
    if (previousFuzzy === undefined) delete process.env.PDL_ALLOW_FUZZY_LOOKUPS;
    else process.env.PDL_ALLOW_FUZZY_LOOKUPS = previousFuzzy;
  }
});

test("fuzzy PDL lookups can be explicitly disabled before spending a credit", async () => {
  const previousKey = process.env.PEOPLE_DATA_SEARCH_KEY;
  const previousFuzzy = process.env.PDL_ALLOW_FUZZY_LOOKUPS;
  let requests = 0;
  process.env.PEOPLE_DATA_SEARCH_KEY = "test-key";
  process.env.PDL_ALLOW_FUZZY_LOOKUPS = "false";
  const connector = new PeopleDataLabsConnector(async () => {
    requests += 1;
    throw new Error("PDL should not have been called");
  });
  try {
    assert.equal(await connector.enrich(enrichmentContext()), null);
    assert.equal(requests, 0);
  } finally {
    if (previousKey === undefined) delete process.env.PEOPLE_DATA_SEARCH_KEY;
    else process.env.PEOPLE_DATA_SEARCH_KEY = previousKey;
    if (previousFuzzy === undefined) delete process.env.PDL_ALLOW_FUZZY_LOOKUPS;
    else process.env.PDL_ALLOW_FUZZY_LOOKUPS = previousFuzzy;
  }
});

test("anchored fuzzy PDL recovery honors the configured provider likelihood", async () => {
  const previousKey = process.env.PEOPLE_DATA_SEARCH_KEY;
  const previousFuzzy = process.env.PDL_ALLOW_FUZZY_LOOKUPS;
  let requestedUrl = "";
  process.env.PEOPLE_DATA_SEARCH_KEY = "test-key";
  delete process.env.PDL_ALLOW_FUZZY_LOOKUPS;
  const connector = new PeopleDataLabsConnector(async (input) => {
    requestedUrl = String(input);
    return new Response(null, { status: 404 });
  });
  try {
    assert.deepEqual(await connector.enrich(enrichmentContext()), { events: [] });
    const request = new URL(requestedUrl);
    assert.equal(request.searchParams.get("name"), "Reviewed Person");
    assert.equal(request.searchParams.get("school"), "Example University");
    assert.equal(request.searchParams.get("min_likelihood"), "8");
  } finally {
    if (previousKey === undefined) delete process.env.PEOPLE_DATA_SEARCH_KEY;
    else process.env.PEOPLE_DATA_SEARCH_KEY = previousKey;
    if (previousFuzzy === undefined) delete process.env.PDL_ALLOW_FUZZY_LOOKUPS;
    else process.env.PDL_ALLOW_FUZZY_LOOKUPS = previousFuzzy;
  }
});

test("roster countries become location anchors instead of company names", () => {
  assert.deepEqual(licensedFuzzyLookupAnchor({
    displayName: "Hengxi Liu",
    identities: [{ provider: "roster-page", externalId: "ioi-2025-1" }],
    affiliations: ["China"],
    sourceUrl: "https://stats.ioinformatics.org/people/1001",
  }), { location: "China" });
  assert.deepEqual(licensedFuzzyLookupAnchor({
    displayName: "Reviewed Person",
    identities: [{ provider: "github", externalId: "1234" }],
    affiliations: ["Example University"],
    location: "California",
    sourceUrl: "https://github.com/reviewed",
  }), { school: "Example University", location: "California" });
});

test("roster evidence repairs malformed country-link affiliations", () => {
  const person = {
    displayName: "Hengxi Liu",
    identities: [{ provider: "roster-page" as const, externalId: "ioi-2025-1" }],
    affiliations: ["https://stats.ioinformatics.org/results/countries/"],
    sourceUrl: "https://stats.ioinformatics.org/results/2025",
  };
  assert.deepEqual(licensedFuzzyLookupAnchor(person, [{
    idempotencyKey: "ioi-1",
    source: "roster-page",
    sourceExternalId: "ioi-1",
    type: "community_recognition",
    title: "Hengxi Liu received gold recognition at IOI 2025",
    description: "1 | Hengxi Liu | China | 591.23 | Gold",
    occurredAt: now.toISOString(),
    discoveredAt: now.toISOString(),
    sourceUrl: person.sourceUrl,
    evidence: [],
    person,
    tags: ["manual-roster-deep-dive"],
    confidence: 0.66,
  }]), { location: "China" });
});

test("a high-confidence provider and model roster match can bind after review", () => {
  const review = {
    verdict: "match" as const,
    decision: "review" as const,
    confidence: 0.88,
    corroboratingSignals: [
      { category: "name" as const, candidateEvidence: "Hengxi Liu", observedEvidence: "Hengxi Liu" },
      { category: "location" as const, candidateEvidence: "China", observedEvidence: "Beijing, China" },
    ],
    conflicts: [],
    summary: "Exact name and compatible country; no conflicts.",
  };
  const person = {
    displayName: "Hengxi Liu",
    identities: [{ provider: "roster-page" as const, externalId: "ioi-2025-1" }],
    affiliations: ["China"],
    sourceUrl: "https://stats.ioinformatics.org/results/2025",
  };

  assert.equal(isGroundedRosterLicensedMatch({
    person,
    requestedName: "Hengxi Liu",
    returnedName: "Hengxi Liu",
    likelihood: 7,
    review,
  }), true);
  assert.equal(isGroundedRosterLicensedMatch({
    person,
    requestedName: "Hengxi Liu",
    returnedName: "Hengxi Liu",
    likelihood: 6,
    review,
  }), false);
  assert.equal(shouldBindLicensedProfileIdentity(false, "review", true), true);
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

test("licensed LinkedIn identities bind only after exact or model-accepted matching", () => {
  assert.equal(shouldBindLicensedProfileIdentity(true), true);
  assert.equal(shouldBindLicensedProfileIdentity(false, "match"), true);
  assert.equal(shouldBindLicensedProfileIdentity(false, "review"), false);
  assert.equal(shouldBindLicensedProfileIdentity(false, "reject"), false);
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
  const modelMatched = {
    ...base,
    confidence: 0.89,
    tags: ["licensed-data", "model-corroborated-identity"],
  };
  assert.equal(isLicensedProfileBriefEvent(modelMatched), true);
  assert.equal(isSubstantiveBriefEvent(modelMatched), true);
});

test("OpenAlex name search binds only a unique name-and-affiliation match", async () => {
  const { matchAuthorByNameAndAffiliation } = await import("../lib/discovery/connectors/openalex");
  const authors = [
    {
      id: "https://openalex.org/A1",
      display_name: "Reviewed Person",
      last_known_institutions: [{ display_name: "Example University" }],
    },
    {
      id: "https://openalex.org/A2",
      display_name: "Reviewed Person",
      last_known_institutions: [{ display_name: "Other Institute" }],
    },
  ];
  assert.equal(
    matchAuthorByNameAndAffiliation(authors, "Reviewed Person", ["Example University"])?.id,
    "https://openalex.org/A1",
  );
  assert.equal(matchAuthorByNameAndAffiliation(authors, "Reviewed Person", ["Unknown Lab"]), null);
  const ambiguous = authors.map((author) => ({
    ...author,
    last_known_institutions: [{ display_name: "Example University" }],
  }));
  assert.equal(matchAuthorByNameAndAffiliation(ambiguous, "Reviewed Person", ["Example University"]), null);
  assert.equal(matchAuthorByNameAndAffiliation(authors, "Reviewed", ["Example University"]), null);
});
