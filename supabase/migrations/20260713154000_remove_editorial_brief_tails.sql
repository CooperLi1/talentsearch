-- Regenerate briefs after rejecting generic editorial tails that do not add
-- source-backed operator information.
do $migration$
declare
  definition text;
begin
  select pg_get_functiondef(
    'public.claim_candidate_brief_batch(bigint,integer,integer)'::regprocedure
  ) into definition;
  execute replace(definition, 'operator-v17', 'operator-v18');
end;
$migration$;
