import { Dashboard, type DashboardCandidateView } from "@/components/dashboard/dashboard";
import { getDashboardData } from "@/lib/data/talent-radar";
import type { Candidate } from "@/lib/domain/types";

function plainText(markdown: string) {
  return markdown.replace(/[*_#`]/g, "").replace(/\s+/g, " ").trim();
}

function shortText(markdown: string, fallback: string) {
  const text = plainText(markdown);
  if (!text) return fallback;
  const firstSentence = text.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim();
  return firstSentence ?? text;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
  }).format(new Date(value));
}

function toDashboardCandidate(candidate: Candidate): DashboardCandidateView {
  const event = candidate.latestEvent;
  const unresolvedIdentity = candidate.identities.find(
    (identity) => identity.resolutionStatus !== "resolved",
  );
  const graphConnection = candidate.connections[0];

  return {
    confidence: candidate.confidence,
    domains: candidate.domains,
    evidence: event
      ? {
          date: formatDate(event.occurredAt ?? event.discoveredAt),
          source: event.sourceLabel,
          title: event.title,
          url: event.sourceUrl,
        }
      : null,
    graphReason: graphConnection
      ? `${graphConnection.relationship} with ${graphConnection.name}`
      : null,
    headline: candidate.headline,
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
    unusualReason: shortText(
      candidate.summaryMarkdown,
      "No review note yet.",
    ),
    whyNow: shortText(
      candidate.whyNowMarkdown,
      event?.summaryMarkdown ?? "No reason recorded yet.",
    ),
  };
}

export default async function HomePage() {
  const data = await getDashboardData();
  const candidates = data.candidates
    .filter((candidate) => ["new", "watching", "saved"].includes(candidate.status))
    .slice(0, 24);

  return (
    <Dashboard
      candidates={candidates.map(toDashboardCandidate)}
      dataMode={data.dataMode}
    />
  );
}
