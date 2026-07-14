import assert from "node:assert/strict";
import test from "node:test";

import {
  LinkedInManualConnector,
  parseApprovedLinkedInProfile,
} from "../lib/discovery/connectors/linkedin-manual";
import {
  isLinkedInDirectAccessApproved,
  normalizeLinkedInMemberUrl,
} from "../lib/discovery/linkedin-policy";

test("normalizes only public LinkedIn member profile URLs", () => {
  assert.equal(
    normalizeLinkedInMemberUrl("https://linkedin.com/in/example-person/?trk=public"),
    "https://www.linkedin.com/in/example-person",
  );
  assert.equal(normalizeLinkedInMemberUrl("https://linkedin.com/company/example"), null);
  assert.equal(normalizeLinkedInMemberUrl("http://linkedin.com/in/example-person"), null);
  assert.equal(normalizeLinkedInMemberUrl("https://evil.example/in/example-person"), null);
});

test("direct LinkedIn access fails closed unless approval, endpoint, and token are present", () => {
  assert.equal(isLinkedInDirectAccessApproved({}), false);
  assert.equal(
    isLinkedInDirectAccessApproved({ LINKEDIN_DIRECT_ACCESS_APPROVED: "true" }),
    false,
  );
  assert.equal(
    isLinkedInDirectAccessApproved({
      LINKEDIN_DIRECT_ACCESS_APPROVED: "false",
      LINKEDIN_APPROVED_API_BASE_URL: "https://api.linkedin.com/rest/",
    }),
    false,
  );
  assert.equal(
    isLinkedInDirectAccessApproved({
      LINKEDIN_DIRECT_ACCESS_APPROVED: "true",
      LINKEDIN_APPROVED_API_BASE_URL: "https://api.linkedin.com/rest/",
      LINKEDIN_APPROVED_API_TOKEN: "server-only-token",
    }),
    true,
  );
});

test("approved profile data must return the exact requested LinkedIn member URL", () => {
  const profile = parseApprovedLinkedInProfile({
    memberId: "urn:li:person:123",
    profileUrl: "https://linkedin.com/in/reviewed-person/?trk=api",
    name: "Reviewed Person",
    alternateNames: ["R. Person"],
  }, "https://www.linkedin.com/in/reviewed-person");
  assert.equal(profile?.memberId, "urn:li:person:123");
  assert.deepEqual(profile?.alternateNames, ["R. Person"]);
  assert.equal(
    parseApprovedLinkedInProfile({
      memberId: "urn:li:person:123",
      profileUrl: "https://www.linkedin.com/in/someone-else",
      name: "Reviewed Person",
    }, "https://www.linkedin.com/in/reviewed-person"),
    null,
  );
});

test("manual ingestion imports only operator-confirmed URLs and preserves provenance", async () => {
  const connector = new LinkedInManualConnector();
  const result = await connector.discover({
    now: new Date("2026-07-12T12:00:00.000Z"),
    settings: {
      enabled: true,
      options: {
        profiles: [
          {
            name: "Reviewed Person",
            profileUrl: "https://linkedin.com/in/reviewed-person/?trk=public",
            provenanceUrl: "https://example.edu/people/reviewed-person",
            reviewed: true,
          },
          {
            name: "Unreviewed Person",
            profileUrl: "https://www.linkedin.com/in/unreviewed-person",
            reviewed: false,
          },
        ],
      },
    },
  });

  assert.equal(result.events.length, 1);
  assert.equal(result.events[0]?.person.displayName, "Reviewed Person");
  assert.equal(result.events[0]?.sourceUrl, "https://example.edu/people/reviewed-person");
  assert.equal(
    result.events[0]?.person.identities[0]?.profileUrl,
    "https://www.linkedin.com/in/reviewed-person",
  );
  assert.equal(result.events[0]?.person.identities[0]?.verified, true);
});
