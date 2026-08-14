-- Recover operator-requested roster candidates whose provider attempts ran
-- without refreshing score/source_count, and allow only this cohort's stale
-- one-line briefs to be regenerated under the new deterministic policy.

update public.events
set event_type = 'competition_result'
where event_type = 'community_recognition'
  and coalesce(raw_payload -> 'tags', '[]'::jsonb) ? 'manual-roster-deep-dive'
  and (
    jsonb_typeof(raw_payload -> 'metrics' -> 'rank') = 'number'
    or coalesce(raw_payload -> 'tags', '[]'::jsonb) ?| array['gold', 'silver', 'bronze']
  );

-- Name plus country alone accepted one clearly incompatible professional
-- profile. Keep the licensed observation for audit/review, but do not treat it
-- as corroborated evidence or leave its profile copy on the roster candidate.
with unsafe_pdl as (
  select distinct events.candidate_id
  from public.events as events
  where events.source_label = 'people-data-labs'
    and events.raw_payload ->> 'matchedBy' = 'provider-and-model-corroborated-roster'
    and not exists (
      select 1
      from jsonb_array_elements(
        coalesce(events.raw_payload -> 'identityReview' -> 'corroboratingSignals', '[]'::jsonb)
      ) as signal
      where signal ->> 'category' in ('identity', 'education', 'work', 'project', 'achievement', 'timeline')
    )
)
update public.candidates as candidates
set headline = null,
    location = null,
    attributes = jsonb_set(
      candidates.attributes - 'biography',
      '{affiliations}',
      coalesce((
        select jsonb_build_array(
          btrim(split_part(roster.raw_payload ->> 'rowText', ' | ', 3))
        )
        from public.events as roster
        where roster.candidate_id = candidates.id
          and coalesce(roster.raw_payload -> 'tags', '[]'::jsonb) ? 'manual-roster-deep-dive'
          and btrim(split_part(roster.raw_payload ->> 'rowText', ' | ', 3)) <> ''
        order by roster.discovered_at desc, roster.id desc
        limit 1
      ), '[]'::jsonb),
      true
    )
from unsafe_pdl
where candidates.id = unsafe_pdl.candidate_id;

update public.events
set confidence = least(confidence, 0.64),
    raw_payload = jsonb_set(
      jsonb_set(
        jsonb_set(raw_payload, '{matchedBy}', '"name-and-anchor-review"'::jsonb, true),
        '{tags}',
        '["licensed-data","model-identity-review","requires-corroboration"]'::jsonb,
        true
      ),
      '{identityReview,decision}',
      '"review"'::jsonb,
      true
    )
where source_label = 'people-data-labs'
  and raw_payload ->> 'matchedBy' = 'provider-and-model-corroborated-roster'
  and not exists (
    select 1
    from jsonb_array_elements(
      coalesce(raw_payload -> 'identityReview' -> 'corroboratingSignals', '[]'::jsonb)
    ) as signal
    where signal ->> 'category' in ('identity', 'education', 'work', 'project', 'achievement', 'timeline')
  );

with deep_dive_candidates as (
  select distinct events.candidate_id
  from public.events as events
  where coalesce(events.raw_payload -> 'tags', '[]'::jsonb) ? 'manual-roster-deep-dive'
), publisher_counts as (
  select
    events.candidate_id,
    count(
      distinct lower(
        regexp_replace(
          events.source_url,
          '^https?://(?:www\.)?([^/]+).*$',
          '\1'
        )
      )
    )::integer as source_count
  from public.events as events
  join deep_dive_candidates on deep_dive_candidates.candidate_id = events.candidate_id
  where events.event_type not in ('profile_observed', 'social_graph_signal', 'identity_observed')
    and events.confidence >= 0.65
  group by events.candidate_id
)
update public.candidates as candidates
set source_count = publisher_counts.source_count
from publisher_counts
where candidates.id = publisher_counts.candidate_id
  and candidates.source_count is distinct from publisher_counts.source_count;

with deep_dive_candidates as (
  select distinct events.candidate_id
  from public.events as events
  where coalesce(events.raw_payload -> 'tags', '[]'::jsonb) ? 'manual-roster-deep-dive'
), external_results as (
  select events.candidate_id, count(*)::integer as result_count
  from public.events as events
  join deep_dive_candidates on deep_dive_candidates.candidate_id = events.candidate_id
  where events.source_label <> 'roster-page'
  group by events.candidate_id
)
update public.candidates as candidates
set enrichment_result_count = greatest(
  candidates.enrichment_result_count,
  external_results.result_count
)
from external_results
where candidates.id = external_results.candidate_id;

create or replace function public.complete_candidate_enrichment_attempt(
  p_workspace_id bigint,
  p_candidate_id bigint,
  p_event_count integer,
  p_attempted_at timestamptz,
  p_research_revision integer
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  next_attempt_count integer;
  current_research_revision integer;
begin
  select
    candidates.enrichment_attempt_count + 1,
    candidates.research_input_revision
  into next_attempt_count, current_research_revision
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
      -- A later empty refresh must not erase a previously persisted result.
      enrichment_result_count = greatest(
        candidates.enrichment_result_count,
        greatest(0, coalesce(p_event_count, 0))
      ),
      enrichment_claimed_until = null,
      research_completed_revision = greatest(
        candidates.research_completed_revision,
        current_research_revision
      ),
      enrichment_next_at = case
        when current_research_revision > greatest(0, coalesce(p_research_revision, 0))
          then clock_timestamp()
        else p_attempted_at + case
          when next_attempt_count < 3 then interval '4 hours'
          when coalesce(p_event_count, 0) > 0 then interval '7 days'
          else interval '30 days'
        end
      end
  where candidates.workspace_id = p_workspace_id
    and candidates.id = p_candidate_id;
end;
$$;

revoke all on function public.complete_candidate_enrichment_attempt(bigint, bigint, integer, timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.complete_candidate_enrichment_attempt(bigint, bigint, integer, timestamptz, integer)
  to service_role;

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
        not exists (
          select 1
          from public.events as deep_dive_event
          where deep_dive_event.workspace_id = candidates.workspace_id
            and deep_dive_event.candidate_id = candidates.id
            and coalesce(deep_dive_event.raw_payload -> 'tags', '[]'::jsonb)
              ? 'manual-roster-deep-dive'
        )
        or candidates.research_completed_revision >= candidates.research_input_revision
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
  'Claims missing briefs plus outdated operator-requested deep-dive briefs.';

revoke all on function public.claim_candidate_brief_batch(bigint, integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_candidate_brief_batch(bigint, integer, integer)
  to service_role;

-- One new revision makes the continuous worker refresh score/source_count for
-- every IOI record under its normal lease and provider-budget controls.
update public.candidates as candidates
set research_input_revision = candidates.research_input_revision + 1,
    enrichment_next_at = clock_timestamp(),
    enrichment_claimed_until = null,
    brief_claimed_until = null
where candidates.status <> 'archived'
  and exists (
    select 1
    from public.events as deep_dive_event
    where deep_dive_event.workspace_id = candidates.workspace_id
      and deep_dive_event.candidate_id = candidates.id
      and coalesce(deep_dive_event.raw_payload -> 'tags', '[]'::jsonb)
        ? 'manual-roster-deep-dive'
  );
