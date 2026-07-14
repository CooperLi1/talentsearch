-- Add verified, multi-author technical feeds while preserving every operator-defined URL
-- and every other source setting. The ordered de-duplication keeps existing URLs first.
with verified_feeds(url, feed_order) as (
  values
    ('https://slack.engineering/feed/'::text, 1),
    ('https://interrupt.memfault.com/feed.xml'::text, 2),
    ('https://embeddedartistry.com/feed/'::text, 3),
    ('https://blog.rust-lang.org/feed.xml'::text, 4)
),
source_urls as (
  select
    source.id,
    source.discovery_config,
    coalesce(
      case
        when jsonb_typeof(source.discovery_config -> 'urls') = 'array'
          then source.discovery_config -> 'urls'
      end,
      '[]'::jsonb
    ) as existing_urls
  from public.sources source
  where source.connector_key = 'technical-blogs'
),
merged_urls as (
  select
    source_urls.id,
    source_urls.discovery_config,
    coalesce(
      (
        select jsonb_agg(to_jsonb(ordered_urls.url) order by ordered_urls.first_position)
        from (
          select candidate_urls.url, min(candidate_urls.position) as first_position
          from (
            select existing.url, existing.position
            from jsonb_array_elements_text(source_urls.existing_urls)
              with ordinality as existing(url, position)
            union all
            select verified.url, jsonb_array_length(source_urls.existing_urls) + verified.feed_order
            from verified_feeds verified
          ) candidate_urls
          group by candidate_urls.url
        ) ordered_urls
      ),
      '[]'::jsonb
    ) as urls
  from source_urls
)
update public.sources source
set discovery_config = jsonb_set(merged.discovery_config, '{urls}', merged.urls, true)
from merged_urls merged
where source.id = merged.id
  and source.discovery_config -> 'urls' is distinct from merged.urls;
