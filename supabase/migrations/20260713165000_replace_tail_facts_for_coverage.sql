-- Regenerate briefs after allowing independently verified supplements to
-- replace tail facts when a full five-fact draft still lacks source coverage.
do $migration$
declare
  definition text;
begin
  select pg_get_functiondef(
    'public.claim_candidate_brief_batch(bigint,integer,integer)'::regprocedure
  ) into definition;
  execute replace(definition, 'operator-v22', 'operator-v23');
end;
$migration$;
