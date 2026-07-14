import type { CriterionSignal } from "@/lib/domain/types";

export const CRITERION_SIGNAL_KEYS = [
  "projectOriginality",
  "technicalComplexity",
  "trajectoryVelocity",
  "networkProximity",
  "achievementQuality",
  "evidenceDiversity",
  "earlyness",
] as const;

export type CriterionSignalKey = (typeof CRITERION_SIGNAL_KEYS)[number];

export const DEFAULT_CRITERION_SIGNALS: CriterionSignal[] = [
  { key: "projectOriginality", label: "Original work", description: "Evidence that someone built something original", weight: 0.2, enabled: true },
  { key: "technicalComplexity", label: "Technical depth", description: "Difficulty and depth of the demonstrated work", weight: 0.18, enabled: true },
  { key: "trajectoryVelocity", label: "Recent momentum", description: "Recent evidence of increasing ambition or output", weight: 0.17, enabled: true },
  { key: "networkProximity", label: "External pull", description: "Independent use, collaboration, or trusted attention", weight: 0.14, enabled: true },
  { key: "achievementQuality", label: "Achievement quality", description: "Difficulty and selectivity of a verified achievement", weight: 0.11, enabled: true },
  { key: "evidenceDiversity", label: "Independent evidence", description: "Agreement across independent public sources", weight: 0.1, enabled: true },
  { key: "earlyness", label: "Still early", description: "Strong work relative to current recognition", weight: 0.1, enabled: true },
];

export function signalsFromWeights(weights: Record<CriterionSignalKey, number>) {
  const total = CRITERION_SIGNAL_KEYS.reduce((sum, key) => sum + weights[key], 0);
  const denominator = total > 0 ? total : 1;
  return DEFAULT_CRITERION_SIGNALS.map((signal) => ({
    ...signal,
    weight: Number((weights[signal.key as CriterionSignalKey] / denominator).toFixed(4)),
  }));
}

export function normalizeCriterionSignals(signals: CriterionSignal[]) {
  const total = signals.reduce(
    (sum, signal) => sum + (signal.enabled && Number.isFinite(signal.weight) ? Math.max(0, signal.weight) : 0),
    0,
  );
  if (total <= 0) return signals;
  return signals.map((signal) => ({
    ...signal,
    weight: signal.enabled ? Number((Math.max(0, signal.weight) / total).toFixed(4)) : 0,
  }));
}
