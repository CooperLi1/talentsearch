import assert from "node:assert/strict";
import test from "node:test";
import { render } from "@react-email/components";
import { createElement } from "react";

import WeeklyDigestEmail from "../emails/weekly-digest";
import { CURRENT_CANDIDATE_BRIEF_POLICY } from "../lib/candidates/brief-policy";
import {
  buildOperatorBrief,
  candidateEvidencePublishers,
  hasGroundedOperatorBrief,
  hasIndependentEvidenceCoverage,
  hasIndependentOperatorBriefCoverage,
  operatorBriefPublishers,
  operatorQueueRank,
} from "../lib/candidates/operator-brief";
import type { Candidate, TalentEvent } from "../lib/domain/types";

function event(overrides: Partial<TalentEvent>): TalentEvent {
  return {
    id: "event-1",
    candidateId: "candidate-1",
    type: "project_created",
    title: "Built an original compiler for low-power devices.",
    summaryMarkdown: "",
    whyItMattersMarkdown: "",
    occurredAt: "2026-07-01T00:00:00.000Z",
    discoveredAt: "2026-07-02T00:00:00.000Z",
    sourceLabel: "GitHub",
    sourceUrl: "https://github.com/example/compiler",
    confidence: 0.95,
    novelty: 80,
    significance: 0,
    links: [],
    ...overrides,
  };
}

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  const events = overrides.events ?? [];
  return {
    id: "candidate-1",
    workspaceId: "1",
    slug: "ada-example",
    name: "Ada Example",
    initials: "AE",
    headline: "Robotics researcher and systems builder.",
    location: "",
    stage: "Undergraduate",
    domains: ["robotics", "systems"],
    score: 82,
    momentum: 0,
    confidence: 0.95,
    confidenceBand: "high",
    status: "new",
    summaryMarkdown: "",
    briefPolicyVersion: CURRENT_CANDIDATE_BRIEF_POLICY,
    whyNowMarkdown: "",
    earlynessMarkdown: "",
    latestEvent: events[0] ?? null,
    events,
    identities: [],
    contactRoutes: [],
    connections: [],
    sourceCount: 0,
    firstSeenAt: "2026-07-01T00:00:00.000Z",
    lastSeenAt: "2026-07-02T00:00:00.000Z",
    scoreComponents: {},
    ...overrides,
  };
}

test("operator briefs use the strongest non-duplicative facts across the full event history", () => {
  const result = buildOperatorBrief(candidate({
    events: [
      event({
        id: "profile",
        type: "profile_observed",
        title: "Ada Example joined a public coding profile.",
        discoveredAt: "2026-07-12T00:00:00.000Z",
      }),
      event({
        id: "medal",
        type: "competition_result",
        title: "Won a gold medal at the International Mathematics Olympiad.",
        sourceLabel: "IMO",
        sourceUrl: "https://www.imo-official.org/participant_r.aspx?id=1",
      }),
      event({
        id: "compiler",
        summaryMarkdown: "Designed a compiler that targets low-power devices and reduces generated binary size.",
        type: "project_created",
        title: "Ada Example built tinycc",
        links: [{ label: "Repository", url: "https://github.com/example/compiler", kind: "primary" }],
      }),
    ],
  }));

  assert.equal(result[0]?.text, "Robotics researcher and systems builder.");
  assert.match(result[1]?.text ?? "", /gold medal/i);
  assert.match(result[2]?.text ?? "", /low-power devices/i);
  assert.equal(result[2]?.sources[0]?.label, "Repository");
  assert.equal(result.length, 3);
  assert.doesNotMatch(result.map((fact) => fact.text).join(" "), /joined a public coding profile/i);
});

test("operator briefs omit internal judgments and unsafe evidence URLs", () => {
  const result = buildOperatorBrief(candidate({
    headline: "Under-recognized candidate worth watching.",
    events: [event({
      links: [{ label: "Unsafe", url: "javascript:alert(1)", kind: "primary" }],
      sourceUrl: "javascript:alert(1)",
    })],
  }));

  assert.doesNotMatch(result.map((fact) => fact.text).join(" "), /under-recognized|worth watching/i);
  assert.deepEqual(result.find((fact) => /compiler/i.test(fact.text))?.sources, []);
});

test("grounded AI briefs replace deterministic event-title bullets", () => {
  const compilerEvent = event({
    sourceLabel: "GitHub",
    sourceUrl: "https://github.com/example/compiler",
    title: "Ada Example built tinycc",
  });
  const result = candidate({
    summaryMarkdown: [
      "- Systems researcher building compilers for constrained devices. [GitHub](https://github.com/example/compiler)",
      "- Designed a compiler that reduces binary size on low-power hardware. [Repository](https://github.com/example/compiler)",
      "- Published the implementation with tests and reproducible benchmarks. [Code](https://github.com/example/compiler)",
    ].join("\n"),
    events: [compilerEvent],
  });

  assert.equal(hasGroundedOperatorBrief(result), true);
  assert.equal(buildOperatorBrief(result).length, 3);
  assert.doesNotMatch(buildOperatorBrief(result).map((fact) => fact.text).join(" "), /built tinycc/i);
  assert.ok(buildOperatorBrief(result).every((fact) => fact.sources[0]?.url === compilerEvent.sourceUrl));
});

test("brief links not present in stored evidence are rejected", () => {
  const result = candidate({
    summaryMarkdown: [
      "- Unsupported claim. [Source](https://example.com/invented)",
      "- Another unsupported claim. [Source](https://example.com/also-invented)",
      "- Third unsupported claim. [Source](https://example.com/nope)",
    ].join("\n"),
    events: [event({})],
  });

  assert.equal(hasGroundedOperatorBrief(result), false);
});

test("one fact shows only one citation chip per publisher", () => {
  const result = candidate({
    summaryMarkdown: [
      "- Rebuilt public web tools without paid accounts. [Post](https://example.dev/post) [Home](https://example.dev/)",
      "- Released the working implementation. [Code](https://github.com/example/tools)",
    ].join("\n"),
    events: [
      event({
        id: "post",
        sourceLabel: "Website",
        sourceUrl: "https://example.dev/post",
        links: [{ label: "Home", url: "https://example.dev/", kind: "primary" }],
      }),
      event({ id: "code", sourceUrl: "https://github.com/example/tools" }),
    ],
  });

  assert.equal(buildOperatorBrief(result)[0]?.sources.length, 1);
  assert.equal(hasIndependentOperatorBriefCoverage(result), true);
});

test("queue ranking rewards a recent substantive event, not a recent profile observation", () => {
  const now = new Date("2026-07-12T00:00:00.000Z");
  const stale = candidate({
    firstSeenAt: "2025-01-01T00:00:00.000Z",
    lastSeenAt: "2026-07-12T00:00:00.000Z",
    events: [event({ type: "profile_observed", discoveredAt: "2026-07-12T00:00:00.000Z" })],
  });
  const recent = candidate({
    firstSeenAt: "2026-07-01T00:00:00.000Z",
    events: [event({ type: "paper_published", discoveredAt: "2026-07-10T00:00:00.000Z" })],
  });

  assert.ok(operatorQueueRank(recent, now) > operatorQueueRank(stale, now));
});

test("independent coverage counts publishers, not pages from one platform", () => {
  const githubOnly = candidate({
    events: [
      event({ id: "one", sourceUrl: "https://github.com/example/one" }),
      event({ id: "two", sourceUrl: "https://github.com/example/two" }),
    ],
  });
  const corroborated = candidate({
    events: [
      ...githubOnly.events,
      event({
        id: "launch",
        sourceLabel: "hacker-news",
        sourceUrl: "https://example.dev/launch",
        title: "Shared a public launch with early users.",
      }),
    ],
  });

  assert.deepEqual(candidateEvidencePublishers(githubOnly), ["github.com"]);
  assert.equal(hasIndependentEvidenceCoverage(githubOnly), false);
  assert.equal(hasIndependentEvidenceCoverage(corroborated), true);
});

test("operator brief coverage requires the displayed bullets to cite multiple publishers", () => {
  const result = candidate({
    events: [
      event({ id: "repo", sourceUrl: "https://github.com/example/compiler" }),
      event({
        id: "paper",
        type: "paper_published",
        sourceLabel: "Semantic Scholar",
        sourceUrl: "https://www.semanticscholar.org/paper/example",
      }),
    ],
    summaryMarkdown: [
      "- Built a compiler for low-power computers. [Repository](https://github.com/example/compiler)",
      "- Published an evaluation of the same approach. [Paper](https://www.semanticscholar.org/paper/example)",
    ].join("\n"),
  });
  const hiddenCorroboration = candidate({
    ...result,
    summaryMarkdown: [
      "- Built a compiler for low-power computers. [Repository](https://github.com/example/compiler)",
      "- Documented how the compiler reduces program size. [Repository](https://github.com/example/compiler)",
    ].join("\n"),
  });

  assert.deepEqual(operatorBriefPublishers(result), ["github.com", "semanticscholar.org"]);
  assert.equal(hasIndependentOperatorBriefCoverage(result), true);
  assert.equal(hasIndependentOperatorBriefCoverage(hiddenCorroboration), false);
});

test("digest cards render only factual bullets, sources, and the dossier action", async () => {
  const html = await render(createElement(WeeklyDigestEmail, {
    digestId: "test-digest",
    periodStart: "2026-07-01T00:00:00.000Z",
    periodEnd: "2026-07-08T00:00:00.000Z",
    dashboardUrl: "https://example.com",
    candidates: [{
      id: "candidate-1",
      name: "Ada Example",
      headline: "Legacy headline",
      summary: "Legacy summary",
      whyNow: "Legacy why now",
      earlyness: "Legacy earlyness",
      confidence: "high",
      sources: [],
      profileUrl: "https://example.com/people/ada",
      facts: [{
        text: "Built an original compiler for low-power devices.",
        sources: [{ label: "Repository", url: "https://github.com/example/compiler" }],
      }],
    }],
  }));

  assert.match(html, /Built an original compiler/);
  assert.match(html, /Repository/);
  assert.match(html, /Open candidate dossier/);
  assert.doesNotMatch(html, /Legacy why now|Legacy earlyness|Identity confidence|Current recognition/);
});
