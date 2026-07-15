-- Spend the most frequent research slots on candidates that are close to the
-- operator queue but still need an independent publisher. Preserve oldest-first
-- rotation for the rest of the backlog so exploration cannot starve.
create or replace function public.claim_candidate_enrichment_batch(
  p_workspace_id bigint,
  p_match_count integer default 5,
  p_claim_seconds integer default 360
)
returns table(candidate_id bigint, research_pass integer, research_revision integer)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  return query
  with policy as (
    select greatest(
      10::numeric,
      coalesce(nullif(criterion_profiles.thresholds ->> 'minimumScore', '')::numeric, 25) * 0.65
    ) as near_queue_score
    from public.criterion_profiles
    where criterion_profiles.workspace_id = p_workspace_id
      and criterion_profiles.status = 'active'
    order by criterion_profiles.version desc
    limit 1
  ), eligible as (
    select
      candidates.id,
      candidates.enrichment_attempt_count,
      candidates.research_input_revision,
      candidates.score,
      candidates.source_count,
      coalesce((select policy.near_queue_score from policy), 16.25) as near_queue_score
    from public.candidates as candidates
    where candidates.workspace_id = p_workspace_id
      and candidates.status <> 'archived'
      and (
        candidates.enrichment_next_at is null
        or candidates.enrichment_next_at <= clock_timestamp()
        or candidates.research_input_revision > candidates.research_completed_revision
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
      (
        candidates.source_count < 2
        and candidates.score >= coalesce((select policy.near_queue_score from policy), 16.25)
      ) desc,
      case
        when candidates.source_count < 2
          and candidates.score >= coalesce((select policy.near_queue_score from policy), 16.25)
        then candidates.score
      end desc nulls last,
      least(candidates.enrichment_attempt_count, 3) asc,
      (candidates.research_input_revision > candidates.research_completed_revision) desc,
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
    returning
      candidates.id,
      eligible.enrichment_attempt_count,
      eligible.research_input_revision
  )
  select claimed.id, claimed.enrichment_attempt_count, claimed.research_input_revision
  from claimed;
end;
$$;

-- Apply the new priority immediately instead of waiting for a previously
-- calculated maintenance date.
with policy as (
  select
    criterion_profiles.workspace_id,
    greatest(
      10::numeric,
      coalesce(nullif(criterion_profiles.thresholds ->> 'minimumScore', '')::numeric, 25) * 0.65
    ) as near_queue_score
  from public.criterion_profiles
  where criterion_profiles.status = 'active'
)
update public.candidates as candidates
set enrichment_next_at = least(
  coalesce(candidates.enrichment_next_at, clock_timestamp()),
  clock_timestamp()
)
from policy
where candidates.workspace_id = policy.workspace_id
  and candidates.status <> 'archived'
  and candidates.source_count < 2
  and candidates.enrichment_attempt_count < 3
  and candidates.score >= policy.near_queue_score;

revoke all on function public.claim_candidate_enrichment_batch(bigint, integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_candidate_enrichment_batch(bigint, integer, integer)
  to service_role;
