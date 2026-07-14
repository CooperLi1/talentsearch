-- Regenerate briefs after replacing combined context facts with the dedicated
-- role and research-focus facts instead of retaining both phrasings.
do $migration$
declare
  definition text;
begin
  select pg_get_functiondef(
    'public.claim_candidate_brief_batch(bigint,integer,integer)'::regprocedure
  ) into definition;
  execute replace(definition, 'operator-v31', 'operator-v32');
end;
$migration$;
