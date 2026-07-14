-- Regenerate briefs after preserving a model-written research-focus fact when
-- it cites candidate-owned evidence that explicitly labels the stated focus.
do $migration$
declare
  definition text;
begin
  select pg_get_functiondef(
    'public.claim_candidate_brief_batch(bigint,integer,integer)'::regprocedure
  ) into definition;
  execute replace(definition, 'operator-v23', 'operator-v24');
end;
$migration$;
