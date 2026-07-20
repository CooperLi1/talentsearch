-- Regenerate briefs as three tightly selected operator facts instead of five.
do $migration$
declare
  definition text;
begin
  select pg_get_functiondef(
    'public.claim_candidate_brief_batch(bigint,integer,integer)'::regprocedure
  ) into definition;
  execute replace(definition, 'operator-v38', 'operator-v39');
end;
$migration$;
