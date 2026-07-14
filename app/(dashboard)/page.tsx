import { Dashboard, type DashboardCandidateView } from "@/components/dashboard/dashboard";
import {
  buildOperatorBrief,
  hasGroundedOperatorBrief,
  hasIndependentEvidenceCoverage,
  hasIndependentOperatorBriefCoverage,
  operatorQueueRank,
} from "@/lib/candidates/operator-brief";
import { getDashboardData } from "@/lib/data/talent-radar";
import type { Candidate } from "@/lib/domain/types";

function toDashboardCandidate(candidate: Candidate): DashboardCandidateView {
  const unresolvedIdentity = candidate.identities.find(
    (identity) => identity.resolutionStatus !== "resolved",
  );

  return {
    facts: buildOperatorBrief(candidate),
    id: candidate.id,
    name: candidate.name,
    referralDisabled:
      Boolean(unresolvedIdentity) || candidate.confidence < 0.72 || /high.?school|minor/i.test(candidate.stage),
    slug: candidate.slug,
    status: candidate.status,
  };
}

export default async function HomePage() {
  const data = await getDashboardData();
  const candidates = data.candidates
    .filter((candidate) =>
      ["new", "watching", "saved"].includes(candidate.status) &&
      candidate.score >= data.criterion.minimumScore &&
      hasGroundedOperatorBrief(candidate) &&
      hasIndependentEvidenceCoverage(candidate) &&
      hasIndependentOperatorBriefCoverage(candidate),
    )
    .sort((left, right) =>
      operatorQueueRank(right) - operatorQueueRank(left) ||
      right.lastSeenAt.localeCompare(left.lastSeenAt),
    )
    .slice(0, 24);

  return (
    <Dashboard
      candidates={candidates.map(toDashboardCandidate)}
      dataMode={data.dataMode}
    />
  );
}
