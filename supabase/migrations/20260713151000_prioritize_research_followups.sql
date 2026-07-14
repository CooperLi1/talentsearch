-- When a pass discovers several new research inputs, let one immediate
-- follow-up consume them before returning to the broad first-pass backlog.
-- This makes cross-source discovery iterative without allowing a stable
-- candidate to monopolize the worker indefinitely.
do $migration$
declare
  definition text;
begin
  select pg_get_functiondef(
    'public.claim_candidate_enrichment_batch(bigint,integer,integer)'::regprocedure
  ) into definition;
  execute replace(
    definition,
    E'least(candidates.enrichment_attempt_count, 3) asc,\n      (candidates.research_input_revision > candidates.research_completed_revision) desc,\n      candidates.score desc',
    E'(candidates.research_input_revision - candidates.research_completed_revision) desc,\n      least(candidates.enrichment_attempt_count, 3) asc,\n      candidates.score desc'
  );
end;
$migration$;
