import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_CRITERION_SIGNALS, normalizeCriterionSignals, signalsFromWeights } from "../lib/criteria/signals";

test("AI priority weights are normalized deterministically", () => {
  const signals = signalsFromWeights({
    projectOriginality: 2,
    technicalComplexity: 2,
    trajectoryVelocity: 1,
    networkProximity: 1,
    achievementQuality: 1,
    evidenceDiversity: 1,
    earlyness: 2,
  });
  assert.equal(Number(signals.reduce((sum, signal) => sum + signal.weight, 0).toFixed(4)), 1);
  assert.equal(signals.find((signal) => signal.key === "technicalComplexity")?.weight, 0.2);
});

test("disabled review signals receive no saved weight", () => {
  const signals = normalizeCriterionSignals(
    DEFAULT_CRITERION_SIGNALS.map((signal, index) => index === 0 ? { ...signal, enabled: false } : signal),
  );
  assert.equal(signals[0]?.weight, 0);
  assert.equal(Number(signals.reduce((sum, signal) => sum + signal.weight, 0).toFixed(4)), 1);
});
