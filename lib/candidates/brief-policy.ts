export const CURRENT_CANDIDATE_BRIEF_POLICY = "operator-v39";

/** Operator-configurable brief length: background, achievements, wild card. */
export function configuredBriefFactCount() {
  const requested = Number(process.env.CANDIDATE_BRIEF_FACT_COUNT ?? 3);
  return Number.isFinite(requested) ? Math.min(5, Math.max(2, Math.floor(requested))) : 3;
}
