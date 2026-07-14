import type { Candidate, EvidenceLink, TalentEvent } from "@/lib/domain/types";
import { CURRENT_CANDIDATE_BRIEF_POLICY } from "./brief-policy";

export type OperatorBriefSource = Pick<EvidenceLink, "label" | "url">;

export type OperatorBriefFact = {
  text: string;
  sources: OperatorBriefSource[];
};

const INTERNAL_JUDGMENT = /\b(?:why now|stands? out|undiscover(?:ed|y)|under[ -]?recognized|review score|identity confidence|strong signal relative|worth watching)\b/i;
const EMPTY_VALUE = /^(?:unknown|unverified|not verified|n\/?a|none)$/i;
const NON_SUBSTANTIVE_EVENT_TYPES = new Set([
  "profile_observed",
  "social_graph_signal",
  "identity_observed",
]);
const PROVIDER_PUBLISHERS: Record<string, string> = {
  github: "github.com",
  gitlab: "gitlab.com",
  "hacker-news": "news.ycombinator.com",
  "hacker news": "news.ycombinator.com",
  arxiv: "arxiv.org",
  crossref: "crossref.org",
  openalex: "openalex.org",
  "semantic-scholar": "semanticscholar.org",
  "semantic scholar": "semanticscholar.org",
  "hugging-face": "huggingface.co",
  "hugging face": "huggingface.co",
  codeforces: "codeforces.com",
  x: "x.com",
};

function plainText(value: string) {
  return value
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^[\s>*#-]+/gm, "")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sentence(value: string, maximumLength = 220) {
  const text = plainText(value);
  if (!text) return "";
  const first = text.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim() ?? text;
  if (first.length <= maximumLength) return first;
  const clipped = first.slice(0, maximumLength + 1);
  const boundary = clipped.lastIndexOf(" ");
  return `${clipped.slice(0, Math.max(boundary, maximumLength - 24)).trim()}…`;
}

function normalizedWords(value: string) {
  return new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 3),
  );
}

function substantiallyDuplicates(value: string, existing: string[]) {
  const words = normalizedWords(value);
  if (!words.size) return true;
  return existing.some((item) => {
    const comparison = normalizedWords(item);
    const overlap = [...words].filter((word) => comparison.has(word)).length;
    return overlap / Math.min(words.size, comparison.size || 1) >= 0.72;
  });
}

function safeSources(event: TalentEvent): OperatorBriefSource[] {
  const candidates = [
    ...event.links.map((link) => ({ label: link.label, url: link.url })),
    { label: event.sourceLabel, url: event.sourceUrl },
  ];
  const seen = new Set<string>();
  return candidates.flatMap((source) => {
    try {
      const url = new URL(source.url);
      if ((url.protocol !== "https:" && url.protocol !== "http:") || seen.has(url.href)) {
        return [];
      }
      seen.add(url.href);
      return [{ label: plainText(source.label) || url.hostname, url: url.href }];
    } catch {
      return [];
    }
  }).slice(0, 2);
}

function eventPublisher(event: TalentEvent) {
  if (NON_SUBSTANTIVE_EVENT_TYPES.has(event.type)) return null;
  const source = event.sourceLabel.trim().toLocaleLowerCase("en-US");
  const providerPublisher = PROVIDER_PUBLISHERS[source];
  if (providerPublisher) return providerPublisher;
  try {
    return new URL(event.sourceUrl).hostname.toLocaleLowerCase("en-US").replace(/^www\./, "");
  } catch {
    return source || null;
  }
}

function sourcePublisher(source: OperatorBriefSource) {
  try {
    return new URL(source.url).hostname.toLocaleLowerCase("en-US").replace(/^www\./, "");
  } catch {
    return null;
  }
}

function operatorSourceLabel(source: OperatorBriefSource) {
  const publisher = sourcePublisher(source);
  const known: Record<string, string> = {
    "github.com": "GitHub",
    "gitlab.com": "GitLab",
    "news.ycombinator.com": "Hacker News",
    "semanticscholar.org": "Semantic Scholar",
    "arxiv.org": "arXiv",
    "openalex.org": "OpenAlex",
    "huggingface.co": "Hugging Face",
  };
  return publisher ? known[publisher] ?? publisher : source.label;
}

/** Different pages on one platform are one publisher, not independent corroboration. */
export function candidateEvidencePublishers(candidate: Candidate) {
  return [
    ...new Set(
      candidate.events.map(eventPublisher).filter((value): value is string => Boolean(value)),
    ),
  ];
}

export function hasIndependentEvidenceCoverage(candidate: Candidate, minimum = 2) {
  return candidateEvidencePublishers(candidate).length >= Math.max(1, Math.floor(minimum));
}

function groundedSummaryFacts(candidate: Candidate): OperatorBriefFact[] {
  if (candidate.briefPolicyVersion !== CURRENT_CANDIDATE_BRIEF_POLICY) return [];
  const allowedSources = new Map<string, OperatorBriefSource>();
  for (const event of candidate.events) {
    for (const source of safeSources(event)) {
      try {
        allowedSources.set(new URL(source.url).href, source);
      } catch {
        // Stored evidence is already validated; malformed legacy URLs stay excluded.
      }
    }
  }

  const facts: OperatorBriefFact[] = [];
  const acceptedText: string[] = [];
  for (const rawLine of candidate.summaryMarkdown.split(/\n+/)) {
    if (!/^\s*[-*]\s+/.test(rawLine)) continue;
    const sources: OperatorBriefSource[] = [];
    const withoutLinks = rawLine.replace(
      /\[([^\]]+)]\((https?:\/\/[^)\s]+)\)/g,
      (_match, label: string, rawUrl: string) => {
        try {
          const allowed = allowedSources.get(new URL(rawUrl).href);
          const publisher = allowed ? sourcePublisher(allowed) : null;
          if (
            allowed &&
            !sources.some((source) =>
              publisher ? sourcePublisher(source) === publisher : source.url === allowed.url,
            )
          ) {
            const proposedLabel = plainText(label);
            sources.push({
              label: /^source(?:\s+\d+)?$/i.test(proposedLabel)
                ? operatorSourceLabel(allowed)
                : proposedLabel || operatorSourceLabel(allowed),
              url: allowed.url,
            });
          }
        } catch {
          // Model output is untrusted; links outside stored evidence are ignored.
        }
        return "";
      },
    );
    const text = sentence(
      withoutLinks
        .replace(/^\s*[-*]\s+/, "")
        .replace(/\(\s*\)/g, "")
        .replace(/\s+([,.;:!?])/g, "$1"),
    );
    if (
      text.length < 18 ||
      !sources.length ||
      INTERNAL_JUDGMENT.test(text) ||
      substantiallyDuplicates(text, acceptedText)
    ) continue;
    facts.push({ text, sources: sources.slice(0, 2) });
    acceptedText.push(text);
    if (facts.length >= 5) break;
  }
  return facts;
}

/** The operator should see the corroboration, not merely have it hidden in storage. */
export function operatorBriefPublishers(candidate: Candidate) {
  return [
    ...new Set(
      groundedSummaryFacts(candidate)
        .flatMap((fact) => fact.sources)
        .map(sourcePublisher)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
}

export function hasIndependentOperatorBriefCoverage(candidate: Candidate, minimum = 2) {
  return operatorBriefPublishers(candidate).length >= Math.max(1, Math.floor(minimum));
}

export function hasGroundedOperatorBrief(candidate: Candidate) {
  return groundedSummaryFacts(candidate).length >= 2;
}

function whoFact(candidate: Candidate): OperatorBriefFact | null {
  const headline = sentence(candidate.headline, 190);
  if (headline && !INTERNAL_JUDGMENT.test(headline)) {
    return { text: headline, sources: [] };
  }

  const stage = plainText(candidate.stage);
  const school = plainText(candidate.school ?? "");
  const location = plainText(candidate.location);
  const parts = [stage, school ? `at ${school}` : "", location ? `in ${location}` : ""]
    .filter((part) => part && !EMPTY_VALUE.test(part));
  if (parts.length) return { text: parts.join(" ").replace(/\s+/g, " "), sources: [] };

  if (candidate.domains.length) {
    return {
      text: `Works in ${candidate.domains.slice(0, 3).join(", ")}.`,
      sources: [],
    };
  }
  return null;
}

function eventQuality(event: TalentEvent) {
  const typeQuality: Record<string, number> = {
    competition_result: 0.95,
    paper_published: 0.9,
    fellowship_or_grant: 0.88,
    hackathon_result: 0.84,
    open_source_contribution: 0.8,
    project_momentum: 0.78,
    project_created: 0.72,
    community_recognition: 0.58,
    social_graph_signal: 0.38,
    profile_observed: 0.15,
  };
  return typeQuality[event.type] ?? 0.5;
}

function eventStrength(event: TalentEvent) {
  return 100 * (
    eventQuality(event) * 0.55 +
    Math.max(0, Math.min(1, event.confidence)) * 0.25 +
    Math.max(0, Math.min(1, event.novelty / 100)) * 0.1 +
    Math.max(0, Math.min(1, event.significance / 100)) * 0.1
  );
}

function eventFact(event: TalentEvent) {
  const title = sentence(event.title);
  const summary = sentence(event.summaryMarkdown);
  const genericRepositoryTitle = /\b(?:built|created|published|released|shared|contributed to)\s+[\w.-]+\.?$/i.test(title);
  const usefulSummary = summary.length >= 32 && !INTERNAL_JUDGMENT.test(summary);

  // Connector titles are often mechanically derived from a repository slug.
  // Prefer the public description when it actually explains what the work does.
  if (genericRepositoryTitle && usefulSummary) return summary;
  if (title.length >= 16 && !INTERNAL_JUDGMENT.test(title)) return title;
  return usefulSummary ? summary : "";
}

function summaryFragments(markdown: string) {
  return markdown
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map((part) => sentence(part))
    .filter((part) => part.length >= 18 && !INTERNAL_JUDGMENT.test(part));
}

/**
 * Produces an operator brief from the candidate's complete stored evidence history.
 * Facts are intentionally extractive: this function never invents credentials or
 * pads a sparse record to reach the requested count.
 */
export function buildOperatorBrief(candidate: Candidate, limit = 5): OperatorBriefFact[] {
  const maximum = Math.max(1, Math.min(5, Math.floor(limit)));
  const grounded = groundedSummaryFacts(candidate);
  if (grounded.length >= 2) return grounded.slice(0, maximum);
  const facts: OperatorBriefFact[] = [];
  const acceptedText: string[] = [];
  const add = (fact: OperatorBriefFact | null) => {
    if (!fact || facts.length >= maximum || substantiallyDuplicates(fact.text, acceptedText)) return;
    facts.push(fact);
    acceptedText.push(fact.text);
  };

  add(whoFact(candidate));

  [...candidate.events]
    .filter((event) => eventQuality(event) >= 0.5)
    .sort((left, right) =>
      eventStrength(right) - eventStrength(left) ||
      (right.occurredAt ?? right.discoveredAt).localeCompare(left.occurredAt ?? left.discoveredAt),
    )
    .forEach((event) => {
      const text = eventFact(event);
      if (text) add({ text, sources: safeSources(event) });
    });

  for (const text of summaryFragments(candidate.summaryMarkdown)) {
    add({ text, sources: [] });
  }

  return facts;
}

export function operatorQueueRank(candidate: Candidate, now = new Date()) {
  const materialEvents = candidate.events.filter((event) => eventQuality(event) >= 0.7);
  const latestMaterialDiscovery = Math.max(
    Date.parse(candidate.firstSeenAt),
    ...materialEvents.map((event) => Date.parse(event.discoveredAt)),
  );
  const ageDays = Number.isFinite(latestMaterialDiscovery)
    ? Math.max(0, (now.getTime() - latestMaterialDiscovery) / 86_400_000)
    : 365;
  const recencyScore = Math.max(0, 100 * (1 - Math.min(ageDays, 60) / 60));
  const strongestEvidence = materialEvents.reduce(
    (strongest, event) => Math.max(strongest, eventStrength(event)),
    0,
  );
  const publisherScore = Math.min(100, candidateEvidencePublishers(candidate).length * 35);
  return candidate.score * 0.67 + recencyScore * 0.16 + strongestEvidence * 0.1 + publisherScore * 0.07;
}
