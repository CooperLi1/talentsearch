alter table public.candidates
  add column if not exists enrichment_attempt_count integer not null default 0
    check (enrichment_attempt_count >= 0),
  add column if not exists enrichment_claimed_until timestamptz;

drop index if exists public.candidates_enrichment_due_idx;

create index candidates_enrichment_due_idx
  on public.candidates (
    workspace_id,
    enrichment_attempt_count,
    score desc,
    source_count,
    enrichment_attempted_at,
    id
  )
  where status <> 'archived';

create or replace function public.claim_candidate_enrichment_batch(
  p_workspace_id bigint,
  p_match_count integer default 5,
  p_claim_seconds integer default 360
)
returns table(candidate_id bigint, research_pass integer)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  return query
  with eligible as (
    select candidates.id, candidates.enrichment_attempt_count
    from public.candidates as candidates
    where candidates.workspace_id = p_workspace_id
      and candidates.status <> 'archived'
      and (
        candidates.enrichment_next_at is null
        or candidates.enrichment_next_at <= clock_timestamp()
      )
      and (
        candidates.enrichment_claimed_until is null
        or candidates.enrichment_claimed_until < clock_timestamp()
      )
      and exists (
        select 1
        from public.identities
        where identities.workspace_id = p_workspace_id
          and identities.candidate_id = candidates.id
          and identities.resolution_status = 'resolved'
      )
    order by
      least(candidates.enrichment_attempt_count, 3) asc,
      candidates.score desc,
      candidates.source_count asc,
      candidates.enrichment_attempted_at asc nulls first,
      candidates.id asc
    for update of candidates skip locked
    limit greatest(1, least(coalesce(p_match_count, 5), 20))
  ), claimed as (
    update public.candidates as candidates
    set enrichment_claimed_until = clock_timestamp() + make_interval(
      secs => greatest(120, least(coalesce(p_claim_seconds, 360), 900))
    )
    from eligible
    where candidates.id = eligible.id
      and candidates.workspace_id = p_workspace_id
    returning candidates.id, eligible.enrichment_attempt_count
  )
  select claimed.id, claimed.enrichment_attempt_count
  from claimed;
end;
$$;

create or replace function public.complete_candidate_enrichment_attempt(
  p_workspace_id bigint,
  p_candidate_id bigint,
  p_event_count integer,
  p_attempted_at timestamptz
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  next_attempt_count integer;
begin
  select candidates.enrichment_attempt_count + 1
  into next_attempt_count
  from public.candidates as candidates
  where candidates.workspace_id = p_workspace_id
    and candidates.id = p_candidate_id
  for update;

  if next_attempt_count is null then
    raise exception 'Candidate not found';
  end if;

  update public.candidates as candidates
  set enrichment_attempt_count = next_attempt_count,
      enrichment_attempted_at = p_attempted_at,
      enrichment_result_count = greatest(0, coalesce(p_event_count, 0)),
      enrichment_claimed_until = null,
      enrichment_next_at = p_attempted_at + case
        when next_attempt_count < 3 then interval '4 hours'
        when coalesce(p_event_count, 0) > 0 then interval '7 days'
        else interval '30 days'
      end
  where candidates.workspace_id = p_workspace_id
    and candidates.id = p_candidate_id;
end;
$$;

revoke all on function public.claim_candidate_enrichment_batch(bigint, integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_candidate_enrichment_batch(bigint, integer, integer)
  to service_role;

revoke all on function public.complete_candidate_enrichment_attempt(bigint, bigint, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function public.complete_candidate_enrichment_attempt(bigint, bigint, integer, timestamptz)
  to service_role;
