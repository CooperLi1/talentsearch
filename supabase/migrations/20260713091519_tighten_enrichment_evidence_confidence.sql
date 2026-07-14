-- Promote only Show HN submissions whose body explicitly attributes the work
-- to the submitter. HTML entities are decoded only for matching; stored public
-- evidence remains unchanged.
update public.events
set
  event_type = 'project_momentum',
  confidence = greatest(confidence, 0.88),
  title = replace(title, ' shared “', ' introduced “')
where source_label = 'hacker-news'
  and title like '%Show HN:%'
  and (
    replace(replace(coalesce(evidence_excerpt, ''), '&#x27;', ''''), '&#39;', '''')
      ~* '(^|[^a-z])(i|we)(''(ve|m)|[[:space:]]+(have|am))?[[:space:]]+(built|made|created|developed|launched|wrote|designed|open[- ]sourced|released|benchmarked|started|authored|working on)([^a-z]|$)'
    or replace(replace(coalesce(evidence_excerpt, ''), '&#x27;', ''''), '&#39;', '''')
      ~* '(^|[^a-z])i(''m|[[:space:]]+am)[[:space:]]+(the[[:space:]]+)?(author|creator|founder|developer|builder)([^a-z]|$)'
  );

-- A handle appearing in page prose is not an identity proof; common handles
-- such as "modinfo" otherwise match unrelated reference pages.
update public.events
set confidence = least(confidence, 0.55)
where source_label = 'brave-enrichment'
  and coalesce(raw_payload -> 'tags', '[]'::jsonb) ? 'handle-match';

with publisher_counts as (
  select
    candidate_id,
    count(
      distinct lower(
        regexp_replace(
          source_url,
          '^https?://(?:www\.)?([^/]+).*$',
          '\1'
        )
      )
    ) filter (
      where event_type not in (
        'profile_observed',
        'social_graph_signal',
        'identity_observed'
      )
      and confidence >= 0.65
    )::integer as source_count
  from public.events
  group by candidate_id
)
update public.candidates as candidate
set source_count = coalesce(publisher_counts.source_count, 0)
from publisher_counts
where candidate.id = publisher_counts.candidate_id
  and candidate.source_count is distinct from publisher_counts.source_count;

update public.candidates
set source_count = 0
where not exists (
  select 1
  from public.events
  where events.candidate_id = candidates.id
    and events.event_type not in (
      'profile_observed',
      'social_graph_signal',
      'identity_observed'
    )
    and events.confidence >= 0.65
)
and source_count <> 0;
