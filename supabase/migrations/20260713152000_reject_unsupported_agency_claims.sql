-- Regenerate operator briefs after adding deterministic protection against
-- turning participation into leadership, founding, or organizing.
do $migration$
declare
  definition text;
begin
  select pg_get_functiondef(
    'public.claim_candidate_brief_batch(bigint,integer,integer)'::regprocedure
  ) into definition;
  execute replace(definition, 'operator-v15', 'operator-v16');
end;
$migration$;
