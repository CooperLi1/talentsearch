import assert from "node:assert/strict";
import test from "node:test";

import {
  getDefaultConnectorSettings,
  parseDiscoveryConfiguration,
  RECOMMENDED_CONNECTOR_QUERIES,
} from "../lib/discovery/config";
import { createConnectorRegistry } from "../lib/discovery/connectors";
import {
  ExaPeopleConnector,
  parseExaPeopleResponse,
} from "../lib/discovery/connectors/exa-people";

const now = new Date("2026-07-25T12:00:00.000Z");

function structuredResponse() {
  return {
    requestId: "request-123",
    results: [{
      id: "result-1",
      title: "Ada Builder",
      url: "https://www.linkedin.com/in/ada-builder?trk=people-search",
      highlights: [
        "Ada maintains a compiler project. ada@example.com +1 (415) 555-0100",
      ],
      entities: [{
        id: "person-ada-123",
        type: "person",
        version: "7",
        properties: {
          name: "Ada Builder",
          location: "San Francisco, California",
          workHistory: [{
            title: "Compiler Engineer",
            company: { id: "company-1", name: "Tiny Systems" },
            dates: { from: "2024-01", to: null },
          }],
          educationHistory: [{
            degree: "BS Computer Science",
            institution: { id: "school-1", name: "Example University" },
            dates: { from: "2020", to: "2024" },
          }],
        },
      }],
    }],
  };
}

test("Exa is registered with a broad eight-search discovery configuration", () => {
  assert.ok(createConnectorRegistry().has("exa-people"));
  assert.equal(RECOMMENDED_CONNECTOR_QUERIES["exa-people"].length, 8);
  assert.equal(getDefaultConnectorSettings()["exa-people"].maxItems, 80);
});

test("Exa stays disabled without a server-side key", () => {
  const previous = process.env.EXA_API_KEY;
  delete process.env.EXA_API_KEY;
  try {
    const settings = parseDiscoveryConfiguration({
      connectors: { "exa-people": { enabled: false } },
    }).connectors["exa-people"];
    assert.equal(settings?.enabled, false);
  } finally {
    if (previous !== undefined) process.env.EXA_API_KEY = previous;
  }
});

test("structured Exa people become discovery leads without verifying LinkedIn", () => {
  const [event] = parseExaPeopleResponse(structuredResponse(), {
    query: "compiler builders",
    now,
  });
  assert.ok(event);
  assert.equal(event.source, "exa-people");
  assert.equal(event.type, "profile_observed");
  assert.equal(event.person.displayName, "Ada Builder");
  assert.equal(event.person.headline, "Compiler Engineer at Tiny Systems");
  assert.equal(event.person.location, "San Francisco, California");
  assert.deepEqual(event.person.affiliations, ["Tiny Systems", "Example University"]);
  assert.match(event.description ?? "", /Compiler Engineer at Tiny Systems/);
  assert.match(event.description ?? "", /\[contact redacted\]/);
  assert.doesNotMatch(event.description ?? "", /ada@example\.com|555-0100/);

  const exaIdentity = event.person.identities.find((identity) => identity.provider === "exa-people");
  const linkedInIdentity = event.person.identities.find(
    (identity) => identity.provider === "linkedin-manual",
  );
  assert.equal(exaIdentity?.externalId, "person-ada-123");
  assert.equal(exaIdentity?.verified, true);
  assert.equal(linkedInIdentity?.profileUrl, "https://www.linkedin.com/in/ada-builder");
  assert.equal(linkedInIdentity?.verified, false);
  assert.equal(event.raw?.contactFieldsStored, false);
  assert.ok(event.tags?.includes("requires-independent-verification"));
  assert.equal(event.person.explicitCareerStage, undefined);
});

test("Exa parsing rejects malformed subjects and non-person entities", () => {
  const events = parseExaPeopleResponse({
    results: [
      {
        id: "missing-entity-id",
        title: "Valid Name",
        url: "https://example.com/person",
        entities: [{ type: "person", properties: { name: "Valid Name" } }],
      },
      {
        id: "company-result",
        title: "Example Company",
        url: "https://example.com/company",
        entities: [{
          id: "company-1",
          type: "company",
          properties: { name: "Example Company" },
        }],
      },
      {
        id: "one-word",
        title: "Developer",
        url: "https://example.com/developer",
      },
      {
        id: "unsafe-url",
        title: "Safe Person",
        url: "http://127.0.0.1/profile",
      },
    ],
  }, { query: "builders", now });
  assert.deepEqual(events, []);
});

test("the same Exa person deduplicates across searches within a week", () => {
  const first = parseExaPeopleResponse(structuredResponse(), {
    query: "compiler builders",
    now,
  })[0];
  const second = parseExaPeopleResponse(structuredResponse(), {
    query: "open-source systems engineers",
    now: new Date("2026-07-26T23:00:00.000Z"),
  })[0];
  assert.equal(first.idempotencyKey, second.idempotencyKey);
  assert.notEqual(first.raw?.queryHash, second.raw?.queryHash);
});

test("Exa discovery is inert without a key", async () => {
  const previous = process.env.EXA_API_KEY;
  delete process.env.EXA_API_KEY;
  try {
    const result = await new ExaPeopleConnector().discover({
      now,
      settings: {
        enabled: true,
        maxItems: 80,
        queries: [...RECOMMENDED_CONNECTOR_QUERIES["exa-people"]],
      },
    });
    assert.deepEqual(result.events, []);
    assert.match(result.warnings?.[0] ?? "", /EXA_API_KEY/);
  } finally {
    if (previous !== undefined) process.env.EXA_API_KEY = previous;
  }
});
