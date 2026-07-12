import type { CandidateFeatureVector, ScoringWeights } from "./types";
import { DEFAULT_SCORING_WEIGHTS } from "./scoring";

export type TasteFeedback = {
  outcome: "pass" | "watch" | "save" | "contact" | "interview" | "accept";
  features: CandidateFeatureVector;
};

const OUTCOME_VALUE: Record<TasteFeedback["outcome"], number> = {
  pass: 0,
  watch: 0.35,
  save: 0.6,
  contact: 0.75,
  interview: 0.9,
  accept: 1,
};

export function updateTasteWeights(input: {
  current?: ScoringWeights;
  baseline?: ScoringWeights;
  feedback: TasteFeedback[];
  learningRate?: number;
}): ScoringWeights {
  const baseline = input.baseline ?? DEFAULT_SCORING_WEIGHTS;
  const current = input.current ?? baseline;
  if (input.feedback.length < 8) return current;
  const learningRate = Math.min(0.02, Math.max(0.001, input.learningRate ?? 0.008));
  const keys = Object.keys(current) as Array<keyof ScoringWeights>;
  const meanOutcome =
    input.feedback.reduce((sum, item) => sum + OUTCOME_VALUE[item.outcome], 0) /
    input.feedback.length;
  const updated = { ...current };

  for (const key of keys) {
    const meanFeature =
      input.feedback.reduce((sum, item) => sum + item.features[key], 0) /
      input.feedback.length;
    const covariance =
      input.feedback.reduce(
        (sum, item) =>
          sum +
          (item.features[key] - meanFeature) *
            (OUTCOME_VALUE[item.outcome] - meanOutcome),
        0,
      ) / input.feedback.length;
    const proposed = current[key] + Math.max(-learningRate, Math.min(learningRate, covariance));
    updated[key] = Math.max(baseline[key] * 0.7, Math.min(baseline[key] * 1.3, proposed));
  }

  const sum = keys.reduce((total, key) => total + updated[key], 0) || 1;
  for (const key of keys) updated[key] /= sum;
  return updated;
}
