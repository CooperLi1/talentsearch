-- Regenerate briefs after separating a combined role-and-focus sentence into
-- two concise operator facts when explicit source evidence supports both.
do $migration$
declare
  definition text;
begin
  select pg_get_functiondef(
    'public.claim_candidate_brief_batch(bigint,integer,integer)'::regprocedure
  ) into definition;
  execute replace(definition, 'operator-v29', 'operator-v30');
end;
$migration$;
