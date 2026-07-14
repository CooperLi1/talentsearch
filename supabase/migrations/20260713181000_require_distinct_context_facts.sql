-- Regenerate briefs after requiring role and research focus to be separate
-- scannable facts and excluding portfolio publication as an achievement.
do $migration$
declare
  definition text;
begin
  select pg_get_functiondef(
    'public.claim_candidate_brief_batch(bigint,integer,integer)'::regprocedure
  ) into definition;
  execute replace(definition, 'operator-v30', 'operator-v31');
end;
$migration$;
