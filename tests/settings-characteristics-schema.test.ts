import assert from "node:assert/strict";
import test from "node:test";

import { settingsUpdateSchema } from "../app/api/_lib/schemas";

function settings(characteristics: unknown[]) {
  return {
    lookForMarkdown: "",
    avoidMarkdown: "",
    minimumScore: 18,
    minimumConfidence: 0.6,
    weeklyCandidateCount: 12,
    digestCadence: "weekly",
    digestDaysOfWeek: [1],
    digestDeliveryHourUtc: 15,
    digestDeliveryMinuteUtc: 0,
    digestPreparationLeadHours: 2,
    explorationRate: 0.1,
    learningRate: 0.01,
    signals: [
      {
        key: "projectOriginality",
        label: "Original work",
        description: "",
        weight: 1,
        enabled: true,
      },
    ],
    characteristics,
  };
}

test("settings allow an empty evidence-characteristic collection", () => {
  assert.doesNotThrow(() => settingsUpdateSchema.parse(settings([])));
});

test("settings accept arbitrary bounded evidence characteristics", () => {
  const parsed = settingsUpdateSchema.parse(
    settings([
      {
        key: "custom_robotics_builder",
        label: "High-school robotics builder",
        description: "Operator-defined rule",
        enabled: true,
        mode: "require",
        evidenceMatch: "all",
        values: ["high school", "robotics"],
      },
    ]),
  );

  assert.ok("characteristics" in parsed);
});

test("enabled custom characteristics require evidence terms", () => {
  assert.throws(() =>
    settingsUpdateSchema.parse(
      settings([
        {
          key: "custom_empty",
          label: "Empty rule",
          description: "",
          enabled: true,
          mode: "prefer",
          evidenceMatch: "all",
          values: [],
        },
      ]),
    ),
  );
});

test("characteristic keys must be safe and unique", () => {
  const duplicate = {
    key: "custom_duplicate",
    label: "Duplicate",
    description: "",
    enabled: false,
    mode: "prefer",
    evidenceMatch: "all",
    values: [],
  };
  assert.throws(() =>
    settingsUpdateSchema.parse(settings([duplicate, duplicate])),
  );
  assert.throws(() =>
    settingsUpdateSchema.parse(
      settings([{ ...duplicate, key: "../../../unsafe" }]),
    ),
  );
});
