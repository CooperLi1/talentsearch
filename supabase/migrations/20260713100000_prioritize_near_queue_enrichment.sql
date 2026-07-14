-- Enrichment is a scarce research budget. Favor the strongest due candidates
-- first, then use low publisher coverage and oldest attempt as tie-breakers.
-- This keeps unreviewed zero-score records from starving candidates that are
-- one corroborating source away from the operator queue.
drop index if exists public.candidates_enrichment_due_idx;

create index candidates_enrichment_due_idx
  on public.candidates (
    workspace_id,
    score desc,
    source_count,
    enrichment_attempted_at,
    id
  )
  where status <> 'archived';
