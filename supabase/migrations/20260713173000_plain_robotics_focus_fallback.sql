-- Regenerate briefs after adding a narrow source-backed plain-language
-- translation for explicitly stated embodied-robotics research terms.
do $migration$
declare
  definition text;
begin
  select pg_get_functiondef(
    'public.claim_candidate_brief_batch(bigint,integer,integer)'::regprocedure
  ) into definition;
  execute replace(definition, 'operator-v26', 'operator-v27');
end;
$migration$;
