-- Let the conservative from-scratch repair and independently verified
-- supplements restore a missing research-focus fact before rejecting a brief.
do $migration$
declare
  definition text;
begin
  select pg_get_functiondef(
    'public.claim_candidate_brief_batch(bigint,integer,integer)'::regprocedure
  ) into definition;
  execute replace(definition, 'operator-v21', 'operator-v22');
end;
$migration$;
