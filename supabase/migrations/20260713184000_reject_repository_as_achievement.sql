-- Regenerate briefs after rejecting repository publication as an achievement;
-- operator copy must state the work or result stored in its evidence instead.
do $migration$
declare
  definition text;
begin
  select pg_get_functiondef(
    'public.claim_candidate_brief_batch(bigint,integer,integer)'::regprocedure
  ) into definition;
  execute replace(definition, 'operator-v33', 'operator-v34');
end;
$migration$;
