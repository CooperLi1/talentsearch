-- Regenerate briefs after adding a bounded, fully re-verified replacement step
-- for rejected facts when the evidence can support the five-fact target.
do $migration$
declare
  definition text;
begin
  select pg_get_functiondef(
    'public.claim_candidate_brief_batch(bigint,integer,integer)'::regprocedure
  ) into definition;
  execute replace(definition, 'operator-v16', 'operator-v17');
end;
$migration$;
