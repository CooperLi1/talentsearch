-- Regenerate briefs after normalizing combined context facts that separate the
-- role and focus with punctuation before "focusing".
do $migration$
declare
  definition text;
begin
  select pg_get_functiondef(
    'public.claim_candidate_brief_batch(bigint,integer,integer)'::regprocedure
  ) into definition;
  execute replace(definition, 'operator-v36', 'operator-v37');
end;
$migration$;
