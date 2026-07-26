-- Expand the reviewed author-attributed feed pool. Every endpoint below was
-- checked with the production FeedConnector on 2026-07-23 and emitted named
-- people without connector warnings. Existing operator URLs remain first.
with verified_feeds(url, feed_order) as (
  values
    ('https://medium.com/feed/airbnb-engineering'::text, 1),
    ('https://stripe.dev/blog/feed'::text, 2),
    ('https://tailscale.com/blog/index.xml'::text, 3),
    ('https://www.canva.dev/blog/engineering/feed.xml'::text, 4),
    ('https://vercel.com/atom'::text, 5),
    ('https://security.googleblog.com/feeds/posts/default'::text, 6),
    ('https://codeascraft.com/feed/'::text, 7),
    ('https://eng.lyft.com/feed'::text, 8),
    ('https://grafana.com/blog/index.xml'::text, 9),
    ('https://www.elastic.co/blog/feed'::text, 10),
    ('https://www.hashicorp.com/blog/feed.xml'::text, 11),
    ('https://www.twilio.com/en-us/blog/feed'::text, 12),
    ('https://engineering.salesforce.com/feed/'::text, 13),
    ('https://tech.instacart.com/feed'::text, 14),
    ('https://medium.com/feed/paypal-tech'::text, 15),
    ('https://medium.com/feed/walmartglobaltech'::text, 16),
    ('https://medium.com/feed/booking-com-development'::text, 17),
    ('https://medium.com/feed/indeed-engineering'::text, 18),
    ('https://medium.com/feed/expedia-group-tech'::text, 19),
    ('https://medium.com/feed/mercadolibre-tech'::text, 20),
    ('https://medium.com/feed/wise-engineering'::text, 21)
),
source_urls as (
  select
    source.id,
    source.max_requests_per_run,
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
    source_urls.max_requests_per_run,
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
            select
              verified.url,
              jsonb_array_length(source_urls.existing_urls) + verified.feed_order
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
set
  max_requests_per_run = case
    when merged.max_requests_per_run = 60 then 120
    else merged.max_requests_per_run
  end,
  discovery_config = case
    when merged.max_requests_per_run = 60
      and merged.discovery_config ->> 'maxItems' = '60'
      then jsonb_set(
        jsonb_set(merged.discovery_config, '{urls}', merged.urls, true),
        '{maxItems}',
        '120'::jsonb,
        true
      )
    else jsonb_set(merged.discovery_config, '{urls}', merged.urls, true)
  end,
  next_run_at = least(source.next_run_at, now())
from merged_urls merged
where source.id = merged.id
  and source.discovery_config -> 'urls' is distinct from merged.urls;
