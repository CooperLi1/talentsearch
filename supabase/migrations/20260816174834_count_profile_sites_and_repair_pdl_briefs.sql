-- Repair only accepted PDL evidence on operator-requested deep dives. Future
-- accepted records use the provider URL and are requeued by the application.

update public.events as events
set source_url = 'https://www.peopledatalabs.com/'
where lower(events.source_label) in ('people-data-labs', 'people data labs')
  and events.confidence >= 0.8
  and coalesce(events.raw_payload -> 'tags', '[]'::jsonb)
    ?| array['verified-provider-subject', 'model-corroborated-identity']
  and exists (
    select 1
    from public.events as roster
    where roster.workspace_id = events.workspace_id
      and roster.candidate_id = events.candidate_id
      and coalesce(roster.raw_payload -> 'tags', '[]'::jsonb)
        ? 'manual-roster-deep-dive'
  )
  and lower(
    regexp_replace(
      events.source_url,
      '^https?://(?:www\.)?([^/]+).*$',
      '\1'
    )
  ) not in ('linkedin.com', 'peopledatalabs.com');

with affected_candidates as (
  select distinct pdl.workspace_id, pdl.candidate_id
  from public.events as pdl
  where lower(pdl.source_label) in ('people-data-labs', 'people data labs')
    and pdl.confidence >= 0.8
    and coalesce(pdl.raw_payload -> 'tags', '[]'::jsonb)
      ?| array['verified-provider-subject', 'model-corroborated-identity']
    and exists (
      select 1
      from public.events as roster
      where roster.workspace_id = pdl.workspace_id
        and roster.candidate_id = pdl.candidate_id
        and coalesce(roster.raw_payload -> 'tags', '[]'::jsonb)
          ? 'manual-roster-deep-dive'
    )
), publisher_counts as (
  select
    candidates.id as candidate_id,
    count(
      distinct lower(
        regexp_replace(
          events.source_url,
          '^https?://(?:www\.)?([^/]+).*$',
          '\1'
        )
      )
    ) filter (where events.id is not null)::integer as source_count
  from public.candidates as candidates
  join affected_candidates
    on affected_candidates.workspace_id = candidates.workspace_id
    and affected_candidates.candidate_id = candidates.id
  left join public.events as events
    on events.workspace_id = candidates.workspace_id
    and events.candidate_id = candidates.id
    and events.event_type not in ('social_graph_signal', 'identity_observed')
    and events.confidence >= 0.65
    and events.source_url ~* '^https?://'
    and lower(
      regexp_replace(
        events.source_url,
        '^https?://(?:www\.)?([^/]+).*$',
        '\1'
      )
    ) <> 'localhost'
    and lower(
      regexp_replace(
        events.source_url,
        '^https?://(?:www\.)?([^/]+).*$',
        '\1'
      )
    ) not like '%.local'
    and (
      lower(events.source_label) not in ('people-data-labs', 'people data labs')
      or (
        events.confidence >= 0.8
        and coalesce(events.raw_payload -> 'tags', '[]'::jsonb)
          ?| array['verified-provider-subject', 'model-corroborated-identity']
      )
    )
  group by candidates.id
)
update public.candidates as candidates
set source_count = publisher_counts.source_count
from publisher_counts
where candidates.id = publisher_counts.candidate_id
  and candidates.source_count is distinct from publisher_counts.source_count;

with affected_candidates as (
  select distinct pdl.workspace_id, pdl.candidate_id
  from public.events as pdl
  where lower(pdl.source_label) in ('people-data-labs', 'people data labs')
    and pdl.confidence >= 0.8
    and coalesce(pdl.raw_payload -> 'tags', '[]'::jsonb)
      ?| array['verified-provider-subject', 'model-corroborated-identity']
    and exists (
      select 1
      from public.events as roster
      where roster.workspace_id = pdl.workspace_id
        and roster.candidate_id = pdl.candidate_id
        and coalesce(roster.raw_payload -> 'tags', '[]'::jsonb)
          ? 'manual-roster-deep-dive'
    )
)
update public.candidates as candidates
set brief_generated_at = null,
    brief_claimed_until = null
from affected_candidates
where candidates.workspace_id = affected_candidates.workspace_id
  and candidates.id = affected_candidates.candidate_id;
