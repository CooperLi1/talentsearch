import { CandidateDossier, type CandidateDossierView } from "@/components/candidates/candidate-dossier";
import { SiteNav } from "@/components/site-nav";
import { getCandidateBySlug } from "@/lib/data/talent-radar";
import type { Candidate } from "@/lib/domain/types";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";

const loadCandidate = cache((slug: string) => getCandidateBySlug(slug));

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const candidate = await loadCandidate(slug);
  return candidate
    ? { title: candidate.name, description: candidate.headline }
    : { title: "Candidate not found" };
}

function formatDate(value: string, includeYear = false) {
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    year: includeYear ? "numeric" : undefined,
  }).format(new Date(value));
}

function toDossier(candidate: Candidate): CandidateDossierView {
  return {
    confidence: candidate.confidence,
    contactRoutes: candidate.contactRoutes.map((route) => ({
      audience: route.audience,
      label: route.label,
      provenanceUrl: route.provenanceUrl,
      url: route.url,
    })),
    domains: candidate.domains,
    earlynessMarkdown: candidate.earlynessMarkdown,
    events: candidate.events.map((event) => ({
      confidence: event.confidence,
      date: formatDate(event.occurredAt ?? event.discoveredAt, true),
      description: event.summaryMarkdown.replace(/[*_#`]/g, ""),
      id: event.id,
      source: event.sourceLabel,
      title: event.title,
      url: event.sourceUrl,
    })),
    headline: candidate.headline,
    id: candidate.id,
    identities: candidate.identities
      .filter((identity) => identity.profileUrl && identity.resolutionStatus !== "rejected")
      .map((identity) => ({
        label: identity.provider,
        status: identity.resolutionStatus,
        url: identity.profileUrl!,
      })),
    initials: candidate.initials,
    lastSeenAt: formatDate(candidate.lastSeenAt, true),
    location: candidate.location,
    momentum: Math.round(candidate.momentum),
    name: candidate.name,
    score: candidate.score,
    stage: candidate.stage,
    status: candidate.status,
    summaryMarkdown: candidate.summaryMarkdown,
    whyNowMarkdown: candidate.whyNowMarkdown,
  };
}

export default async function CandidatePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const candidate = await loadCandidate(slug);
  if (!candidate) notFound();

  return (
    <main className="app-main operator-page dossier-page">
      <SiteNav />
      <div className="content-frame operator-shell">
        <CandidateDossier candidate={toDossier(candidate)} />
      </div>
    </main>
  );
}
