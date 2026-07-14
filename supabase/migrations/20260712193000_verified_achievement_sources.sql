-- Add reviewed, official achievement sources without overwriting operator-tuned rows.
-- Every page below was verified as server-rendered and compatible with the
-- generic structured-results connector on 2026-07-12.

with legacy_olympiads as (
  select
    w.id as workspace_id,
    '{"enabled":true,"maxItems":100,"options":{"pages":[{"url":"https://www.imo-official.org/results/individual/year/2025/","itemSelector":".data-table-wrapper table[data-results-anomaly-table] tbody > tr","nameSelector":"[data-person-name]","rankSelector":"td:nth-child(3)","affiliationSelector":".data-table__country-full","linkSelector":"td:first-child a","titleSelector":"td:nth-child(4)","eventName":"International Mathematical Olympiad 2025","eventType":"competition_result","occurredAt":"2025-07-20"}]}}'::jsonb as discovery_config
  from public.workspaces w
  where w.slug = 'unfound'
),
reviewed_olympiads as (
  select
    workspace_id,
    '{"enabled":true,"maxItems":100,"options":{"pages":[{"url":"https://www.imo-official.org/results/individual/year/2025/","itemSelector":".data-table-wrapper table[data-results-anomaly-table] tbody > tr","nameSelector":"[data-person-name]","rankSelector":"td:nth-child(3)","affiliationSelector":".data-table__country-full","linkSelector":"td:first-child a","titleSelector":"td:nth-child(4)","eventName":"International Mathematical Olympiad 2025","eventType":"competition_result","occurredAt":"2025-07-20"},{"url":"https://www.icho-official.org/results/results.php?id=57&year=2025","itemSelector":".table-responsive tbody tr","nameSelector":"td:nth-child(1)","affiliationSelector":"td:nth-child(3)","rankSelector":"td:nth-child(4)","titleSelector":"td:nth-child(5)","eventName":"International Chemistry Olympiad 2025","eventType":"competition_result","occurredAt":"2025-07-14T00:00:00.000Z"}]}}'::jsonb as discovery_config
  from legacy_olympiads
)
update public.sources source
set discovery_config = reviewed.discovery_config
from legacy_olympiads legacy
join reviewed_olympiads reviewed using (workspace_id)
where source.workspace_id = legacy.workspace_id
  and source.connector_key = 'olympiads'
  and source.name = 'Official olympiad results'
  and source.kind = 'competition-results'
  and source.enabled = true
  and source.status = 'active'
  and source.max_requests_per_run = 100
  and source.discovery_config = legacy.discovery_config;

with untouched_science_fairs as (
  select w.id as workspace_id
  from public.workspaces w
  join public.sources source
    on source.workspace_id = w.id
   and source.connector_key = 'science-fairs'
  where w.slug = 'unfound'
    and source.name = 'Science fairs and research competitions'
    and source.kind = 'science-fairs'
    and source.base_url = 'https://www.societyforscience.org/isef/'
    and source.enabled = false
    and source.status = 'disabled'
    and source.max_requests_per_run = 100
    and source.discovery_config = '{"enabled":false,"maxItems":100}'::jsonb
)
update public.sources source
set
  base_url = 'https://www.societyforscience.org/regeneron-sts/',
  enabled = true,
  status = 'active',
  discovery_config = '{"enabled":true,"maxItems":100,"options":{"pages":[{"url":"https://www.societyforscience.org/regeneron-sts/2026-student-finalists/","itemSelector":".post-archive-item[data-post-type=\"finalist\"]","nameSelector":".archive-item-title a","linkSelector":".archive-item-title a","eventName":"Regeneron Science Talent Search 2026 Finalist","eventType":"competition_result","occurredAt":"2026-01-21T00:00:00.000Z"}]}}'::jsonb
from untouched_science_fairs untouched
where source.workspace_id = untouched.workspace_id
  and source.connector_key = 'science-fairs';

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
  workspace.id,
  'science-fairs',
  'Science fairs and research competitions',
  'science-fairs',
  'https://www.societyforscience.org/regeneron-sts/',
  'active',
  true,
  100,
  '{"enabled":true,"maxItems":100,"options":{"pages":[{"url":"https://www.societyforscience.org/regeneron-sts/2026-student-finalists/","itemSelector":".post-archive-item[data-post-type=\"finalist\"]","nameSelector":".archive-item-title a","linkSelector":".archive-item-title a","eventName":"Regeneron Science Talent Search 2026 Finalist","eventType":"competition_result","occurredAt":"2026-01-21T00:00:00.000Z"}]}}'::jsonb
from public.workspaces workspace
where workspace.slug = 'unfound'
on conflict (workspace_id, connector_key) do nothing;

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
  workspace.id,
  'fellowships',
  'Selective technical fellowships',
  'structured-results',
  'https://www.hertzfoundation.org/hertz-fellowship/',
  'active',
  true,
  100,
  '{"enabled":true,"maxItems":100,"options":{"pages":[{"url":"https://www.hertzfoundation.org/hertz-fellowship/2026-hertz-fellows/","itemSelector":".fellow-card","nameSelector":".fellow-lister-name a","affiliationSelector":".fellow-lister-school:not(.year)","titleSelector":".expertise","linkSelector":".fellow-lister-name a","eventName":"Hertz Fellowship 2026","eventType":"competition_result","occurredAt":"2026-05-06T00:00:00.000Z"}]}}'::jsonb
from public.workspaces workspace
where workspace.slug = 'unfound'
on conflict (workspace_id, connector_key) do nothing;
