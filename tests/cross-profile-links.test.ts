import assert from "node:assert/strict";
import test from "node:test";

import {
  extractCrossProfileClaims,
  extractSingleGitHubProfileHandle,
  resolveCrossProfileClaims,
} from "../lib/discovery/cross-profile-links";
import { resolveIdentity } from "../lib/discovery/identity";
import type { IdentityCandidate, PersonObservation } from "../lib/discovery/types";

test("extracts one direct GitHub profile link from public profile HTML", () => {
  assert.equal(
    extractSingleGitHubProfileHandle(
      '<p>I build databases. <a href="https://github.com/signal-builder">code</a></p>',
    ),
    "signal-builder",
  );
});

test("rejects repository, reserved-route, and conflicting GitHub links", () => {
  assert.equal(
    extractSingleGitHubProfileHandle('<a href="https://github.com/ada/compiler">repo</a>'),
    null,
  );
  assert.equal(
    extractSingleGitHubProfileHandle('<a href="https://github.com/topics">topics</a>'),
    null,
  );
  assert.equal(
    extractSingleGitHubProfileHandle(
      '<a href="https://github.com/ada">Ada</a><a href="https://github.com/grace">Grace</a>',
    ),
    null,
  );
});

test("a verified secondary provider subject can resolve an existing candidate", () => {
  const observation: PersonObservation = {
    displayName: "hn_handle",
    sourceUrl: "https://news.ycombinator.com/user?id=hn_handle",
    identities: [
      {
        provider: "hacker-news",
        externalId: "hn_handle",
        verified: true,
      },
      {
        provider: "github",
        externalId: "12345",
        username: "signal-builder",
        verified: true,
      },
    ],
  };
  const candidate: IdentityCandidate = {
    id: "9",
    displayName: "Different public name",
    identities: [
      {
        provider: "github",
        externalId: "12345",
        username: "signal-builder",
        verified: true,
      },
    ],
  };
  assert.deepEqual(resolveIdentity(observation, [candidate]), {
    action: "match",
    candidateId: "9",
    confidence: 1,
    reasons: ["Exact github identifier"],
  });
});

test("same names without a durable identifier remain separate", () => {
  const observation: PersonObservation = {
    displayName: "Alex Kim",
    sourceUrl: "https://news.ycombinator.com/user?id=alexk",
    identities: [{ provider: "hacker-news", externalId: "alexk", verified: true }],
  };
  const candidate: IdentityCandidate = {
    id: "11",
    displayName: "Alex Kim",
    identities: [{ provider: "github", externalId: "999", verified: true }],
  };
  const decision = resolveIdentity(observation, [candidate]);
  assert.equal(decision.action, "create");
});

test("an unverified cross-profile identifier is proposed for review, not merged", () => {
  const observation: PersonObservation = {
    displayName: "hn-handle",
    sourceUrl: "https://news.ycombinator.com/user?id=hn-handle",
    identities: [
      { provider: "hacker-news", externalId: "hn-handle", verified: true },
      {
        provider: "github",
        externalId: "12345",
        username: "different-handle",
        verified: false,
      },
    ],
  };
  const candidate: IdentityCandidate = {
    id: "9",
    displayName: "A Different Name",
    identities: [
      {
        provider: "github",
        externalId: "12345",
        username: "different-handle",
        verified: true,
      },
    ],
  };
  const decision = resolveIdentity(observation, [candidate]);
  assert.equal(decision.action, "review");
  if (decision.action === "review") {
    assert.deepEqual(decision.possibleCandidateIds, ["9"]);
  }
});

test("extracts self-declared profiles without mistaking repositories or share links for people", () => {
  const claims = extractCrossProfileClaims(
    `
      <a href="https://github.com/ada/compiler">compiler</a>
      <a rel="me" href="https://x.com/ada_codes">X</a>
      <a href="https://twitter.com/intent/tweet">share</a>
      <a href="https://www.linkedin.com/in/ada-lovelace/">LinkedIn</a>
      <script type="application/ld+json">
        {"@type":"Person","sameAs":["https://gitlab.com/ada-l","https://news.ycombinator.com/user?id=ada"]}
      </script>
    `,
    "https://ada.example",
  );
  assert.deepEqual(
    claims.map(({ provider, handle, proof }) => ({ provider, handle, proof })),
    [
      { provider: "x", handle: "ada_codes", proof: "rel-me" },
      { provider: "linkedin-manual", handle: "ada-lovelace", proof: "profile-link" },
      { provider: "gitlab", handle: "ada-l", proof: "jsonld-same-as" },
      { provider: "hacker-news", handle: "ada", proof: "jsonld-same-as" },
    ],
  );
});

test("only explicit self-links from a verified owned page bind providers without durable APIs", async () => {
  const identities = await resolveCrossProfileClaims({
    sourceOwned: true,
    claims: [
      {
        provider: "x",
        handle: "ada_codes",
        profileUrl: "https://x.com/ada_codes",
        proof: "rel-me",
      },
      {
        provider: "linkedin-manual",
        handle: "ada-lovelace",
        profileUrl: "https://www.linkedin.com/in/ada-lovelace",
        proof: "profile-link",
      },
    ],
  });
  assert.equal(identities.find((identity) => identity.provider === "x")?.verified, true);
  assert.equal(
    identities.find((identity) => identity.provider === "linkedin-manual")?.verified,
    false,
  );
});

test("a matching handle on a candidate-owned page verifies a cross-provider profile", async () => {
  const identities = await resolveCrossProfileClaims({
    sourceOwned: true,
    expectedIdentities: [{
      provider: "github",
      externalId: "123",
      username: "ada_codes",
      verified: true,
    }],
    claims: [{
      provider: "x",
      handle: "ada_codes",
      profileUrl: "https://x.com/ada_codes",
      proof: "profile-link",
    }],
  });

  assert.equal(identities[0]?.verified, true);
});

test("ordinary personal-site links are not treated as candidate identities", () => {
  assert.deepEqual(
    extractCrossProfileClaims(
      '<a href="https://employer.example">Employer</a><a rel="me" href="https://ada.example/about">Me</a>',
      "https://ada.example",
    ),
    [
      {
        provider: "website",
        profileUrl: "https://ada.example/about",
        proof: "rel-me",
      },
    ],
  );
});
