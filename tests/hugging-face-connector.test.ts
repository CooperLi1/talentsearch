import assert from "node:assert/strict";
import test from "node:test";

import { getDefaultConnectorSettings } from "../lib/discovery/config";
import {
  analyzeHuggingFaceArtifactMetadata,
  isPublicHuggingFaceArtifact,
  selectHuggingFaceQueryIndex,
} from "../lib/discovery/connectors/hugging-face";
import { createConnectorRegistry } from "../lib/discovery/connectors";

test("Hugging Face defaults are reviewed before enablement and fit the query budget", () => {
  const settings = getDefaultConnectorSettings()["hugging-face"];
  assert.equal(settings.enabled, false);
  assert.equal(settings.maxItems, 45);
  assert.equal(settings.lookbackDays, 30);
  assert.equal(settings.queries?.length, 8);
  assert.ok(createConnectorRegistry().has("hugging-face"));
});

test("Hugging Face query rotation stays deterministic and bounded", () => {
  const queries = ["robotics", "compiler", "bioinformatics"];
  assert.equal(selectHuggingFaceQueryIndex(queries, undefined), 0);
  assert.equal(selectHuggingFaceQueryIndex(queries, 1), 1);
  assert.equal(selectHuggingFaceQueryIndex(queries, 4), 1);
  assert.equal(selectHuggingFaceQueryIndex(queries, -1), 0);
});

test("Hugging Face discovery admits only explicitly public, ungated artifacts", () => {
  const publicModel = {
    _id: "stable-model-id",
    author: "builder",
    gated: false,
    id: "builder/runtime-model",
    private: false,
  };
  assert.equal(isPublicHuggingFaceArtifact("model", publicModel), true);
  assert.equal(isPublicHuggingFaceArtifact("model", { ...publicModel, private: true }), false);
  assert.equal(isPublicHuggingFaceArtifact("model", { ...publicModel, gated: true }), false);
  assert.equal(isPublicHuggingFaceArtifact("model", { ...publicModel, _id: undefined }), false);
});

test("Hugging Face complexity uses static metadata without reading artifact contents", () => {
  const analysis = analyzeHuggingFaceArtifactMetadata("space", {
    _id: "space-id",
    author: "builder",
    cardData: { sdk: "docker" },
    id: "builder/systems-demo",
    private: false,
    siblings: [
      { rfilename: "Dockerfile" },
      { rfilename: "pyproject.toml" },
      { rfilename: "src/runtime.py" },
      { rfilename: "tests/runtime.test.py" },
      { rfilename: ".github/workflows/check.yml" },
    ],
  });
  assert.ok(analysis.score >= 0.5);
  assert.ok(analysis.confidence >= 0.5);
  assert.ok(analysis.indicators.includes("containerized runtime"));
  assert.ok(analysis.indicators.includes("test suite"));
  assert.ok(analysis.indicators.includes("automated validation"));
});
