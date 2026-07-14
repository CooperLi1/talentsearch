-- Keep the verified existing fact set when merging required context. Exact
-- duplicate text is still removed; semantic context is handled at generation.
do $migration$
declare
  definition text;
begin
  select pg_get_functiondef(
    'public.claim_candidate_brief_batch(bigint,integer,integer)'::regprocedure
  ) into definition;
  execute replace(definition, 'operator-v32', 'operator-v33');
end;
$migration$;
