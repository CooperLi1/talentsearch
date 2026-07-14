-- Regenerate briefs after distinguishing role and affiliation facts from
-- research-topic facts, and removing another specialist research term.
do $migration$
declare
  definition text;
begin
  select pg_get_functiondef(
    'public.claim_candidate_brief_batch(bigint,integer,integer)'::regprocedure
  ) into definition;
  execute replace(definition, 'operator-v28', 'operator-v29');
end;
$migration$;
