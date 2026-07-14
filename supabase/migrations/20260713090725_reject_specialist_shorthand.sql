-- Keep the existing bounded claim function while invalidating briefs that may
-- still contain implementation acronyms under the v12 language policy.
do $migration$
declare
  definition text;
begin
  select pg_get_functiondef(
    'public.claim_candidate_brief_batch(bigint,integer,integer)'::regprocedure
  ) into definition;
  execute replace(definition, 'operator-v12', 'operator-v13');
end;
$migration$;
