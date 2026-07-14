-- Regenerate briefs after adding a bounded, plain-language repair dedicated to
-- explicit role, affiliation, and research-focus evidence.
do $migration$
declare
  definition text;
begin
  select pg_get_functiondef(
    'public.claim_candidate_brief_batch(bigint,integer,integer)'::regprocedure
  ) into definition;
  execute replace(definition, 'operator-v24', 'operator-v25');
end;
$migration$;
