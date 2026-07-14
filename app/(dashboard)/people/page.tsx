import { PeopleSearch, type PeopleCandidateView } from "@/components/people/people-search";
import { SiteNav } from "@/components/site-nav";
import {
  DataNotConfiguredError,
  getDataReadiness,
  listCandidates,
} from "@/lib/data/talent-radar";
import {
  buildOperatorBrief,
  hasGroundedOperatorBrief,
} from "@/lib/candidates/operator-brief";
import type { Candidate } from "@/lib/domain/types";
import { preferredContactRoute } from "@/lib/contact/routes";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Search" };

function toPeopleCandidate(candidate: Candidate): PeopleCandidateView {
  const unresolvedIdentity = candidate.identities.find(
    (identity) => identity.resolutionStatus !== "resolved",
  );
  const contactRoute = preferredContactRoute(candidate.contactRoutes);

  return {
    confidence: candidate.confidence,
    contactRoute: contactRoute
      ? { label: contactRoute.label, url: contactRoute.url }
      : null,
    domains: candidate.domains,
    eventTypes: [...new Set(candidate.events.map((item) => item.type))],
    facts: hasGroundedOperatorBrief(candidate)
      ? buildOperatorBrief(candidate, 5)
      : [],
    id: candidate.id,
    identityWarning: unresolvedIdentity
      ? `${unresolvedIdentity.provider} identity needs review`
      : candidate.confidence < 0.72
        ? "Identity confidence is low"
        : null,
    initials: candidate.initials,
    location: candidate.location,
    name: candidate.name,
    score: candidate.score,
    slug: candidate.slug,
    sourceLabels: [...new Set(candidate.events.map((item) => item.sourceLabel))],
    stage: candidate.stage,
    status: candidate.status,
    thesis: candidate.headline,
  };
}

export default async function PeoplePage() {
  let readiness = getDataReadiness();
  let candidates: Candidate[] = [];
  try {
    candidates = await listCandidates({ limit: 250 });
  } catch (error) {
    if (!(error instanceof DataNotConfiguredError)) throw error;
    readiness = { ...readiness, dataMode: "unconfigured" };
  }

  return (
    <main className="app-main operator-page">
      <SiteNav />
      <div className="content-frame operator-shell">
        <header className="operator-header operator-header-compact">
          <div>
            <p className="eyebrow">Candidate records</p>
            <h1>Search people</h1>
            <p>Search by a person&apos;s work, background, or linked evidence.</p>
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
