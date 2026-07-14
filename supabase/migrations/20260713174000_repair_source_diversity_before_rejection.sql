-- Let the independently verified repair and replacement passes restore a
-- second publisher before the final brief contract rejects the draft.
do $migration$
declare
  definition text;
begin
  select pg_get_functiondef(
    'public.claim_candidate_brief_batch(bigint,integer,integer)'::regprocedure
  ) into definition;
  execute replace(definition, 'operator-v27', 'operator-v28');
end;
$migration$;
