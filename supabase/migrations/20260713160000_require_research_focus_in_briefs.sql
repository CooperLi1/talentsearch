-- Regenerate briefs after making explicitly stated research focus a required
-- operator fact and excluding presentational portfolio/homepage filler.
do $migration$
declare
  definition text;
begin
  select pg_get_functiondef(
    'public.claim_candidate_brief_batch(bigint,integer,integer)'::regprocedure
  ) into definition;
  execute replace(definition, 'operator-v19', 'operator-v20');
end;
$migration$;
