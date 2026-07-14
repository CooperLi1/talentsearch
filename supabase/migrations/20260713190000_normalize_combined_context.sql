-- Regenerate briefs after reducing a combined role-and-focus context fact to
-- the role whenever a separate verified research-focus fact already exists.
do $migration$
declare
  definition text;
begin
  select pg_get_functiondef(
    'public.claim_candidate_brief_batch(bigint,integer,integer)'::regprocedure
  ) into definition;
  execute replace(definition, 'operator-v35', 'operator-v36');
end;
$migration$;
