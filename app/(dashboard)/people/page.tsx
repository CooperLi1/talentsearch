import { PeopleSearch, type PeopleCandidateView } from "@/components/people/people-search";
import { SiteNav } from "@/components/site-nav";
import { getDataReadiness, listCandidates } from "@/lib/data/talent-radar";
import type { Candidate } from "@/lib/domain/types";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Search" };

function plainText(markdown: string) {
  return markdown.replace(/[*_#`]/g, "").replace(/\s+/g, " ").trim();
}

function firstSentence(markdown: string, fallback: string) {
  const text = plainText(markdown);
  return text.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim() ?? text ?? fallback;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
  }).format(new Date(value));
}

function toPeopleCandidate(candidate: Candidate): PeopleCandidateView {
  const event = candidate.latestEvent;
  const unresolvedIdentity = candidate.identities.find(
    (identity) => identity.resolutionStatus !== "resolved",
  );

  return {
    confidence: candidate.confidence,
    domains: candidate.domains,
    evidence: event ? `${event.sourceLabel} · ${event.title}` : null,
    id: candidate.id,
    identityWarning: unresolvedIdentity
      ? `${unresolvedIdentity.provider} identity needs review`
      : candidate.confidence < 0.72
        ? "Identity confidence is low"
        : null,
    initials: candidate.initials,
    location: candidate.location,
    name: candidate.name,
    recency: formatDate(event?.discoveredAt ?? candidate.lastSeenAt),
    score: candidate.score,
    slug: candidate.slug,
    stage: candidate.stage,
    status: candidate.status,
    thesis: candidate.headline,
    whyNow: firstSentence(
      candidate.whyNowMarkdown,
      "No review note yet.",
    ),
  };
}

export default async function PeoplePage() {
  const readiness = getDataReadiness();
  const candidates = await listCandidates({ limit: 250 });

  return (
    <main className="app-main operator-page">
      <SiteNav />
      <div className="content-frame operator-shell">
        <header className="operator-header operator-header-compact">
          <div>
            <p className="eyebrow">Candidate records</p>
            <h1>Search people</h1>
            <p>Find people by demonstrated work, background, and verified evidence.</p>
          </div>
        </header>
        <PeopleSearch
          candidates={candidates.map(toPeopleCandidate)}
          dataMode={readiness.dataMode}
        />
      </div>
    </main>
  );
}
