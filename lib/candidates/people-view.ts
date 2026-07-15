import {
  buildOperatorBrief,
  hasGroundedOperatorBrief,
  type OperatorBriefFact,
} from "@/lib/candidates/operator-brief";
import { preferredContactRoute } from "@/lib/contact/routes";
import type { Candidate } from "@/lib/domain/types";

export type PeopleCandidateView = {
  confidence: number;
  contactRoute: { label: string; url: string } | null;
  domains: string[];
  eventTypes: string[];
  facts: OperatorBriefFact[];
  id: string;
  identityWarning: string | null;
  initials: string;
  location: string;
  name: string;
  score: number;
  slug: string;
  sourceLabels: string[];
  stage: string;
  status: string;
  thesis: string;
};

export function toPeopleCandidateView(candidate: Candidate): PeopleCandidateView {
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
