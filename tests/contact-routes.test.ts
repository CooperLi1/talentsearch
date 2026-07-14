import assert from "node:assert/strict";
import test from "node:test";

import {
  contactRoutesFromIdentities,
  normalizeContactRoutes,
  preferredContactRoute,
} from "../lib/contact/routes";
import { publicContactRoutesFromHtml } from "../lib/discovery/connectors/web-presence";

test("candidate-owned pages expose only explicit public contact links", () => {
  const routes = publicContactRoutesFromHtml(
    `<a href="mailto:person@example.com">Email</a>
     <a href="/contact">Get in touch</a>
     <p>Guessed address: first.last@example.com</p>`,
    "https://example.com/",
    "college student",
  );

  assert.deepEqual(routes.map((route) => route.kind), ["email", "contact-page"]);
  assert.equal(routes[0]?.url, "mailto:person@example.com");
  assert.ok(routes.every((route) => route.provenanceUrl === "https://example.com/"));
});

test("direct contact is suppressed for likely minors", () => {
  const routes = publicContactRoutesFromHtml(
    `<a href="mailto:student@example.com">Email</a>
     <a href="/contact">Contact me</a>
     <a href="https://research.example.edu/lab">University lab</a>`,
    "https://student.example/",
    "high school student",
  );

  assert.deepEqual(routes.map((route) => route.kind), ["institutional"]);
});

test("unresolved identities do not become contact routes", () => {
  const routes = contactRoutesFromIdentities([
    {
      id: "1",
      provider: "github",
      providerSubjectId: "github-1",
      profileUrl: "https://github.com/example",
      displayName: "Example Person",
      resolutionStatus: "unresolved",
      confidence: 0.99,
    },
    {
      id: "2",
      provider: "linkedin-manual",
      providerSubjectId: "linkedin-2",
      profileUrl: "https://www.linkedin.com/in/example",
      displayName: "Example Person",
      resolutionStatus: "resolved",
      confidence: 0.96,
    },
  ]);

  assert.deepEqual(routes.map((route) => route.kind), ["linkedin"]);
});

test("malformed and low-confidence routes fail closed", () => {
  const routes = normalizeContactRoutes([
    {
      kind: "email",
      label: "Email",
      url: "mailto:not-an-email",
      provenanceUrl: "https://example.com",
      confidence: 1,
      verified: true,
      audience: "direct",
    },
    {
      kind: "github",
      label: "GitHub",
      url: "https://github.com/example",
      provenanceUrl: "https://github.com/example",
      confidence: 0.5,
      verified: true,
      audience: "public-profile",
    },
  ]);

  assert.deepEqual(routes, []);
});

test("preferred contact favors an explicit route over a social profile", () => {
  const routes = normalizeContactRoutes([
    {
      kind: "github",
      label: "GitHub",
      url: "https://github.com/example",
      provenanceUrl: "https://github.com/example",
      confidence: 0.99,
      verified: true,
      audience: "public-profile",
    },
    {
      kind: "contact-page",
      label: "Contact page",
      url: "https://example.com/contact",
      provenanceUrl: "https://example.com",
      confidence: 0.92,
      verified: true,
      audience: "direct",
    },
  ]);

  assert.equal(preferredContactRoute(routes)?.kind, "contact-page");
});
