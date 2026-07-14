-- Regenerate briefs after fixing replacement verification so valid replacement
-- candidates are not truncated before their individual evidence check.
do $migration$
declare
  definition text;
begin
  select pg_get_functiondef(
    'public.claim_candidate_brief_batch(bigint,integer,integer)'::regprocedure
  ) into definition;
  execute replace(definition, 'operator-v18', 'operator-v19');
end;
$migration$;
