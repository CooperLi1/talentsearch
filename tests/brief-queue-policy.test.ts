import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260729034028_generate_only_missing_candidate_briefs.sql",
    import.meta.url,
  ),
  "utf8",
);
const renderBlueprint = readFileSync(new URL("../render.yaml", import.meta.url), "utf8");

test("brief claims are limited to candidates without a generated brief", () => {
  assert.match(migration, /candidates\.brief_generated_at is null/);
  assert.doesNotMatch(migration, /brief_evidence_fingerprint is distinct from/);
  assert.doesNotMatch(migration, /brief_prompt_version is distinct from/);
  assert.match(migration, /for update of candidates skip locked/);
});

test("the continuous brief worker uses the lower-cost direct OpenAI model", () => {
  assert.match(
    renderBlueprint,
    /- key: AI_SUMMARY_MODEL\s+value: gpt-4o-mini/,
  );
  assert.doesNotMatch(renderBlueprint, /gpt-5\.6-luna/);
});
