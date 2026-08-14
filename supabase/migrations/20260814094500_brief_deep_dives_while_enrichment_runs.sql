-- An authoritative operator-requested roster result is sufficient for the
-- deterministic baseline brief. Do not hold that brief behind optional
-- provider enrichment; later substantive evidence changes the fingerprint
-- and queues the candidate for another brief pass.
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
        'operator-v40|' ||
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
    from public.events as events
    where events.workspace_id = p_workspace_id
      and events.event_type not in ('profile_observed', 'social_graph_signal', 'identity_observed')
      and events.confidence >= 0.65
    group by events.candidate_id
    having count(distinct events.content_hash) >= 1
  ), eligible as (
    select
      candidates.id,
      substantive.fingerprint,
      substantive.publisher_count,
      exists (
        select 1
        from public.events as deep_dive_event
        where deep_dive_event.workspace_id = candidates.workspace_id
          and deep_dive_event.candidate_id = candidates.id
          and coalesce(deep_dive_event.raw_payload -> 'tags', '[]'::jsonb)
            ? 'manual-roster-deep-dive'
      ) as is_deep_dive
    from public.candidates as candidates
    join substantive on substantive.candidate_id = candidates.id
    where candidates.workspace_id = p_workspace_id
      and candidates.status <> 'archived'
      and (
        candidates.brief_generated_at is null
        or (
          exists (
            select 1
            from public.events as deep_dive_event
            where deep_dive_event.workspace_id = candidates.workspace_id
              and deep_dive_event.candidate_id = candidates.id
              and coalesce(deep_dive_event.raw_payload -> 'tags', '[]'::jsonb)
                ? 'manual-roster-deep-dive'
          )
          and (
            candidates.brief_prompt_version is distinct from 'operator-v40'
            or candidates.brief_evidence_fingerprint is distinct from substantive.fingerprint
          )
        )
      )
      and exists (
        select 1
        from public.identities
        where identities.workspace_id = candidates.workspace_id
          and identities.candidate_id = candidates.id
          and identities.resolution_status = 'resolved'
      )
      and (
        candidates.brief_claimed_until is null
        or candidates.brief_claimed_until < clock_timestamp()
      )
    order by is_deep_dive desc,
      (substantive.publisher_count >= 2) desc,
      candidates.score desc,
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

comment on function public.claim_candidate_brief_batch(bigint, integer, integer) is
  'Claims missing briefs and outdated deep-dive briefs without blocking authoritative baseline briefs on optional enrichment.';

revoke all on function public.claim_candidate_brief_batch(bigint, integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_candidate_brief_batch(bigint, integer, integer)
  to service_role;
