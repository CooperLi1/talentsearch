-- Regenerate briefs after separating the required identity/affiliation fact
-- from the required research-focus fact in the bounded repair pass.
do $migration$
declare
  definition text;
begin
  select pg_get_functiondef(
    'public.claim_candidate_brief_batch(bigint,integer,integer)'::regprocedure
  ) into definition;
  execute replace(definition, 'operator-v20', 'operator-v21');
end;
$migration$;
