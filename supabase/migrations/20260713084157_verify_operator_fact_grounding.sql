-- Regenerate candidate briefs after switching their grounding input from
-- prior model copy to connector-extracted evidence and adding a fact-check pass.
create or replace function public.claim_candidate_brief_batch(
  p_workspace_id bigint,
  p_match_count integer default 30,
  p_claim_seconds integer default 300
)
returns table(candidate_id bigint, evidence_fingerprint text)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  return query
  with substantive as (
    select
      events.candidate_id,
      md5(
        'operator-v10|' ||
        string_agg(events.content_hash, ',' order by events.discovered_at, events.id)
      ) as fingerprint,
      max(events.discovered_at) as latest_evidence_at,
      count(
        distinct lower(
          regexp_replace(
            events.source_url,
            '^https?://(?:www\.)?([^/]+).*$',
            '\1'
          )
        )
      ) as publisher_count
    from public.events
    where events.workspace_id = p_workspace_id
      and events.event_type not in (
        'profile_observed',
        'social_graph_signal',
        'identity_observed'
      )
      and events.confidence >= 0.65
    group by events.candidate_id
    having count(distinct events.content_hash) >= 1
  ), eligible as (
    select candidates.id, substantive.fingerprint, substantive.publisher_count
    from public.candidates
    join substantive on substantive.candidate_id = candidates.id
    where candidates.workspace_id = p_workspace_id
      and candidates.status <> 'archived'
      and exists (
        select 1
        from public.identities
        where identities.workspace_id = candidates.workspace_id
          and identities.candidate_id = candidates.id
          and identities.resolution_status = 'resolved'
      )
      and (
        candidates.brief_evidence_fingerprint is distinct from substantive.fingerprint
        or candidates.brief_prompt_version is distinct from 'operator-v10'
      )
      and (
        candidates.brief_claimed_until is null
        or candidates.brief_claimed_until < clock_timestamp()
      )
    order by (substantive.publisher_count >= 2) desc,
      candidates.score desc,
      candidates.brief_generated_at asc nulls first,
      substantive.latest_evidence_at desc,
      candidates.id asc
    for update of candidates skip locked
    limit greatest(1, least(coalesce(p_match_count, 30), 50))
  ), claimed as (
    update public.candidates as candidates
    set brief_claimed_until = clock_timestamp() + make_interval(
      secs => greatest(60, least(coalesce(p_claim_seconds, 300), 1800))
    )
    from eligible
    where candidates.id = eligible.id
      and candidates.workspace_id = p_workspace_id
    returning candidates.id, eligible.fingerprint
  )
  select claimed.id, claimed.fingerprint
  from claimed;
end;
$$;

revoke all on function public.claim_candidate_brief_batch(bigint, integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_candidate_brief_batch(bigint, integer, integer)
  to service_role;
