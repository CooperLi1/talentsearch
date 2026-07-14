-- Regenerate briefs after preserving a narrow plain-language project fact when
-- stored GitHub evidence explicitly states the robot, training, and deployment.
do $migration$
declare
  definition text;
begin
  select pg_get_functiondef(
    'public.claim_candidate_brief_batch(bigint,integer,integer)'::regprocedure
  ) into definition;
  execute replace(definition, 'operator-v37', 'operator-v38');
end;
$migration$;
