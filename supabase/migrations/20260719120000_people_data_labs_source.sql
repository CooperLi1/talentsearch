-- Licensed professional-profile enrichment via People Data Labs.
-- The connector only runs when PEOPLE_DATA_SEARCH_KEY is configured; this row
-- makes the source visible and operator-tunable alongside other connectors.
insert into public.sources (
  workspace_id,
  connector_key,
  name,
  kind,
  base_url,
  status,
  enabled,
  max_requests_per_run,
  discovery_config
)
select
  w.id,
  'people-data-labs',
  'People Data Labs licensed profiles',
  'people-data-labs',
  'https://docs.peopledatalabs.com/docs/person-enrichment-api',
  'disabled',
  false,
  5,
  '{"enabled":false,"maxItems":5,"lookbackDays":90,"options":{"minLikelihood":8}}'::jsonb
from public.workspaces w
where w.slug = 'unfound'
on conflict (workspace_id, connector_key) do nothing;
