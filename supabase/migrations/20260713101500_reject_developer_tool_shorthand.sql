-- Invalidate briefs that may expose developer-only shorthand such as "linter"
-- to a generalist operator. Preserve the established claim order and bounds.
do $migration$
declare
  definition text;
begin
  select pg_get_functiondef(
    'public.claim_candidate_brief_batch(bigint,integer,integer)'::regprocedure
  ) into definition;
  execute replace(definition, 'operator-v13', 'operator-v14');
end;
$migration$;
