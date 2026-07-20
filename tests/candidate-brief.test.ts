import assert from "node:assert/strict";
import test from "node:test";

import {
  attachEquivalentPublisherCitations,
  filterVerifiedOperatorFacts,
  hasUnsupportedAgencyClaim,
  isSubstantiveBriefEvent,
  isCandidateIntroductionEvidence,
  isGroundedCandidateBrief,
  needsPlainLanguageRetry,
  selectDiverseBriefEvidence,
} from "@/lib/ai/summaries";
import { operatorFactsGenerationSchema } from "@/lib/ai/schemas";
import { briefEvidenceDescription } from "@/lib/candidates/brief-evidence";
import type { DiscoveryEvent } from "@/lib/discovery/types";

const event: DiscoveryEvent = {
  idempotencyKey: "event-1",
  source: "github",
  sourceExternalId: "repo-1",
  type: "project_created",
  title: "Built a compiler",
  occurredAt: "2026-07-01T00:00:00.000Z",
  discoveredAt: "2026-07-02T00:00:00.000Z",
  sourceUrl: "https://github.com/example/compiler",
  evidence: [{ label: "Repository", url: "https://github.com/example/compiler" }],
  person: {
    displayName: "Ada Example",
    identities: [],
    sourceUrl: "https://github.com/example",
  },
  confidence: 0.95,
};

test("candidate brief completion requires two source-linked grounded bullets", () => {
  const brief = [
    "- Builds compilers for constrained hardware. [Repository](https://github.com/example/compiler)",
    "- Published tests for the compiler implementation. [Repository](https://github.com/example/compiler)",
    "- Documented reproducible performance measurements. [Repository](https://github.com/example/compiler)",
  ].join("\n");

  assert.equal(isGroundedCandidateBrief(brief, [event]), true);
  assert.equal(isGroundedCandidateBrief(brief.replaceAll("github.com", "example.com"), [event]), false);
  assert.equal(isGroundedCandidateBrief(brief.split("\n").slice(0, 2).join("\n"), [event]), true);
  assert.equal(isGroundedCandidateBrief(brief.split("\n").slice(0, 1).join("\n"), [event]), false);
});

test("brief evidence interleaves publishers before repeating one", () => {
  const githubEvents = Array.from({ length: 4 }, (_, index) => ({
    ...event,
    idempotencyKey: `github-${index}`,
    sourceExternalId: `repo-${index}`,
    sourceUrl: `https://github.com/example/repo-${index}`,
  }));
  const research: DiscoveryEvent = {
    ...event,
    idempotencyKey: "paper",
    source: "semantic-scholar",
    sourceExternalId: "paper-1",
    sourceUrl: "https://www.semanticscholar.org/paper/example",
  };

  assert.deepEqual(
    selectDiverseBriefEvidence([...githubEvents, research], 3).map((item) => item.source),
    ["github", "semantic-scholar", "github"],
  );

  const braveGitHub: DiscoveryEvent = {
    ...event,
    idempotencyKey: "brave-github",
    source: "brave-enrichment",
    sourceExternalId: "brave-repo",
    sourceUrl: "https://github.com/example/another-repo",
  };
  assert.deepEqual(
    selectDiverseBriefEvidence([githubEvents[0], braveGitHub, research], 3)
      .map((item) => item.source),
    ["github", "semantic-scholar", "brave-enrichment"],
  );
});

test("equivalent DOI authorship evidence adds a visible independent citation", () => {
  const identity = {
    provider: "doi-authorship" as const,
    externalId: "10.1145/example.123#author-0",
    verified: true,
  };
  const semanticScholar: DiscoveryEvent = {
    ...event,
    source: "semantic-scholar",
    sourceUrl: "https://www.semanticscholar.org/paper/example",
    person: { ...event.person, identities: [identity] },
  };
  const crossref: DiscoveryEvent = {
    ...event,
    idempotencyKey: "crossref-paper",
    source: "crossref",
    sourceUrl: "https://doi.org/10.1145/example.123",
    person: { ...event.person, identities: [identity] },
  };
  assert.deepEqual(
    attachEquivalentPublisherCitations([
      { text: "Ada Example published a paper about compilers.", sourceIds: ["E1"] },
    ], [semanticScholar, crossref]),
    [{
      text: "Ada Example published a paper about compilers.",
      sourceIds: ["E1", "E2"],
    }],
  );
});

test("candidate-owned role and research evidence leads the 20-second brief context", () => {
  const personalSite: DiscoveryEvent = {
    ...event,
    idempotencyKey: "personal-site",
    source: "web-presence",
    sourceExternalId: "owned-site",
    sourceUrl: "https://ada.example",
    title: "Ada Example's public work profile",
    description: "Incoming PhD student at Example University researching robots that learn from demonstrations.",
    tags: ["personal-site", "candidate-owned-work-page"],
    type: "other",
    confidence: 0.9,
  };
  const repository = { ...event, idempotencyKey: "repo", confidence: 0.99 };

  assert.equal(isCandidateIntroductionEvidence(personalSite), true);
  assert.equal(isCandidateIntroductionEvidence(repository), false);
  assert.equal(selectDiverseBriefEvidence([repository, personalSite], 2)[0], personalSite);

  const indexedPaper: DiscoveryEvent = {
    ...personalSite,
    source: "semantic-scholar",
    type: "paper_published",
    description: "Research on database systems and distributed computing.",
    tags: undefined,
  };
  assert.equal(isCandidateIntroductionEvidence(indexedPaper), false);
});

test("operator brief schema bounds facts to the configurable range", () => {
  const fact = (index: number) => ({
    text: `Grounded candidate fact number ${index + 1}`,
    sourceIds: [`E${index + 1}`],
  });
  const three = operatorFactsGenerationSchema.safeParse({
    operatorFacts: Array.from({ length: 3 }, (_, index) => fact(index)),
  });
  assert.equal(three.success, true);
  const six = operatorFactsGenerationSchema.safeParse({
    operatorFacts: Array.from({ length: 6 }, (_, index) => fact(index)),
  });
  assert.equal(six.success, false);
});

test("configured brief fact count clamps to a sane range", async () => {
  const { configuredBriefFactCount } = await import("../lib/candidates/brief-policy");
  const previous = process.env.CANDIDATE_BRIEF_FACT_COUNT;
  try {
    delete process.env.CANDIDATE_BRIEF_FACT_COUNT;
    assert.equal(configuredBriefFactCount(), 3);
    process.env.CANDIDATE_BRIEF_FACT_COUNT = "5";
    assert.equal(configuredBriefFactCount(), 5);
    process.env.CANDIDATE_BRIEF_FACT_COUNT = "1";
    assert.equal(configuredBriefFactCount(), 2);
    process.env.CANDIDATE_BRIEF_FACT_COUNT = "12";
    assert.equal(configuredBriefFactCount(), 5);
    process.env.CANDIDATE_BRIEF_FACT_COUNT = "not-a-number";
    assert.equal(configuredBriefFactCount(), 3);
  } finally {
    if (previous === undefined) delete process.env.CANDIDATE_BRIEF_FACT_COUNT;
    else process.env.CANDIDATE_BRIEF_FACT_COUNT = previous;
  }
});

test("plain-language review catches implementation jargon and filler", () => {
  assert.equal(needsPlainLanguageRetry([{ text: "Built an API gateway for edge-native apps." }]), true);
  assert.equal(needsPlainLanguageRetry([{ text: "The project is available on GitHub." }]), true);
  assert.equal(needsPlainLanguageRetry([{ text: "Created a public repository for a robot arm project." }]), true);
  assert.equal(needsPlainLanguageRetry([{ text: "Built a public repository for a robot arm project." }]), true);
  assert.equal(needsPlainLanguageRetry([{ text: "Created a personal homepage using a site template." }]), true);
  assert.equal(needsPlainLanguageRetry([{ text: "Published an embodied AI portfolio for interviews." }]), true);
  assert.equal(needsPlainLanguageRetry([{ text: "Launched a public portfolio for embodied AI." }]), true);
  assert.equal(needsPlainLanguageRetry([{ text: "Built a library that improves internet data transfer." }]), true);
  assert.equal(needsPlainLanguageRetry([{ text: "Created software for faster database software." }]), true);
  assert.equal(needsPlainLanguageRetry([{ text: "Built a beginner-friendly VLA project starter." }]), true);
  assert.equal(needsPlainLanguageRetry([{ text: "Studies Vision-Language-Action models for robots." }]), true);
  assert.equal(needsPlainLanguageRetry([{ text: "Developed a full-stack E2EE messenger." }]), true);
  assert.equal(needsPlainLanguageRetry([{ text: "Built a linter for AI tool configurations." }]), true);
  assert.equal(needsPlainLanguageRetry([{ text: "Tracked robot success rates, providing measurable insights." }]), true);
  assert.equal(needsPlainLanguageRetry([{ text: "Published a starter project, facilitating their entry into robotics." }]), true);
  assert.equal(needsPlainLanguageRetry([{ text: "Built a robot arm, demonstrating practical applications of AI." }]), true);
  assert.equal(needsPlainLanguageRetry([{ text: "Won silver, highlighting competitive skills in robotics." }]), true);
  assert.equal(needsPlainLanguageRetry([{ text: "Tracked failures, improving the reliability of robot operations." }]), true);
  assert.equal(needsPlainLanguageRetry([{ text: "Built a tool that helps robots recognize and pick up objects." }]), false);
  assert.equal(needsPlainLanguageRetry([{
    text: "Built a very long description with enough ordinary words to exceed the concise investor brief contract even though the sentence avoids specialist vocabulary and remains easy to understand entirely.",
  }]), true);
});

test("low-confidence link sharing cannot become candidate brief evidence", () => {
  assert.equal(isSubstantiveBriefEvent({ ...event, confidence: 0.55 }), false);
  assert.equal(isSubstantiveBriefEvent({ ...event, confidence: 0.88 }), true);
});

test("fact verification fails closed on missing or duplicate verdicts", () => {
  const facts = [{ text: "One" }, { text: "Two" }, { text: "Three" }];

  assert.deepEqual(filterVerifiedOperatorFacts(facts, [
    { factIndex: 0, supported: true },
    { factIndex: 1, supported: false },
    { factIndex: 2, supported: true },
  ]), [facts[0], facts[2]]);
  assert.deepEqual(filterVerifiedOperatorFacts(facts, [
    { factIndex: 0, supported: true },
    { factIndex: 0, supported: true },
    { factIndex: 2, supported: true },
  ]), []);
  assert.deepEqual(filterVerifiedOperatorFacts(facts, [
    { factIndex: 0, supported: true },
    { factIndex: 2, supported: true },
  ]), []);
});

test("briefs cannot promote participation into an unsupported leadership role", () => {
  const evidence = [{
    evidenceId: "E1",
    title: "RoboCup result",
    description: "Joined THMOS in RoboCup China and won a silver medal.",
  }];
  assert.equal(hasUnsupportedAgencyClaim({
    text: "Led a team that won silver at RoboCup China.",
    sourceIds: ["E1"],
  }, evidence), true);
  assert.equal(hasUnsupportedAgencyClaim({
    text: "Won silver with THMOS at RoboCup China.",
    sourceIds: ["E1"],
  }, evidence), false);
});

test("candidate brief grounding prefers connector evidence over model event copy", () => {
  assert.equal(briefEvidenceDescription({
    evidenceExcerpt: "Raw text extracted from the public page.",
    summaryMarkdown: "Earlier model-generated summary.",
  }), "Raw text extracted from the public page.");
  assert.equal(briefEvidenceDescription({
    summaryMarkdown: "Legacy event summary.",
  }), "Legacy event summary.");
});
