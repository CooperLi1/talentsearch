import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260814090000_recover_ioi_deep_dive_pipeline.sql",
    import.meta.url,
  ),
  "utf8",
);

const nonblockingBriefMigration = readFileSync(
  new URL(
    "../supabase/migrations/20260814094500_brief_deep_dives_while_enrichment_runs.sql",
    import.meta.url,
  ),
  "utf8",
);

test("IOI recovery is targeted and preserves prior enrichment successes", () => {
  assert.match(migration, /manual-roster-deep-dive/);
  assert.match(migration, /event_type = 'competition_result'/);
  assert.match(migration, /greatest\(\s*candidates\.enrichment_result_count/);
  assert.match(migration, /brief_prompt_version is distinct from 'operator-v40'/);
  assert.match(migration, /for update of candidates skip locked/);
});

test("authoritative deep-dive briefs are not blocked on optional enrichment", () => {
  assert.match(nonblockingBriefMigration, /manual-roster-deep-dive/);
  assert.match(nonblockingBriefMigration, /brief_prompt_version is distinct from 'operator-v40'/);
  assert.doesNotMatch(nonblockingBriefMigration, /research_completed_revision/);
  assert.match(nonblockingBriefMigration, /for update of candidates skip locked/);
});
