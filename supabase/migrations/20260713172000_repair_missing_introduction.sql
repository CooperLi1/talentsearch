-- Let the dedicated required-context repair restore a missing role or
-- affiliation before the final evidence contract rejects a brief.
do $migration$
declare
  definition text;
begin
  select pg_get_functiondef(
    'public.claim_candidate_brief_batch(bigint,integer,integer)'::regprocedure
  ) into definition;
  execute replace(definition, 'operator-v25', 'operator-v26');
end;
$migration$;
