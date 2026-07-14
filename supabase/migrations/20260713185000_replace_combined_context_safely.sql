-- Regenerate briefs after replacing combined context only when the verified
-- context repair already contains distinct role and research-focus facts.
do $migration$
declare
  definition text;
begin
  select pg_get_functiondef(
    'public.claim_candidate_brief_batch(bigint,integer,integer)'::regprocedure
  ) into definition;
  execute replace(definition, 'operator-v34', 'operator-v35');
end;
$migration$;
