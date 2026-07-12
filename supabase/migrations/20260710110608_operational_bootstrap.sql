-- Operational defaults for a fresh Talent Radar project.
-- This migration is deliberately idempotent and never creates people, events,
-- feedback, digests, or subscribers. Existing workspace settings win.

insert into public.workspaces (slug, name, created_by)
values ('unfound', 'Unfound', null)
on conflict (slug) do nothing;

-- Seed one active, editable plain-language criterion only when this workspace
-- has no active profile. Version selection is workspace-local and does not
-- depend on generated IDs.
insert into public.criterion_profiles (
  workspace_id,
  name,
  version,
  status,
  update_origin,
  look_for_md,
  avoid_md,
  signal_weights,
  thresholds,
  digest_config,
  learning_rate,
  exploration_rate,
  training_sample_count,
  change_summary,
  change_set,
  activated_at
)
select
  w.id,
  'Early technical builders',
  coalesce((select max(existing.version) + 1 from public.criterion_profiles existing where existing.workspace_id = w.id), 1),
  'active',
  'bootstrap',
  'Look for people who build original, technically difficult things; learn quickly; attract independent users, collaborators, or expert attention; and still appear under-recognized relative to the quality of their work.',
  'Avoid profiles supported mainly by credentials, follower counts, engagement farming, copied projects, unverifiable claims, or broad recognition without recent evidence of original work.',
  jsonb_build_object(
    'signals',
    jsonb_build_array(
      jsonb_build_object('key', 'achievementQuality', 'label', 'Achievement quality', 'description', 'Selective outcomes corroborate ability without substituting for original work.', 'weight', 0.25, 'enabled', true),
      jsonb_build_object('key', 'trajectoryVelocity', 'label', 'Learning velocity', 'description', 'Recent work shows increasing ambition, pace, or scope.', 'weight', 0.17, 'enabled', true),
      jsonb_build_object('key', 'projectOriginality', 'label', 'Project originality', 'description', 'The person created a new capability or reframed a neglected problem.', 'weight', 0.14, 'enabled', true),
      jsonb_build_object('key', 'technicalComplexity', 'label', 'Technical depth', 'description', 'Public artifacts demonstrate difficult, substantive implementation work.', 'weight', 0.15, 'enabled', true),
      jsonb_build_object('key', 'networkProximity', 'label', 'Network signal', 'description', 'Credible collaborators or expert communities independently engage with the work.', 'weight', 0.12, 'enabled', true),
      jsonb_build_object('key', 'evidenceDiversity', 'label', 'Evidence diversity', 'description', 'Independent sources corroborate the same trajectory.', 'weight', 0.08, 'enabled', true),
      jsonb_build_object('key', 'earlyness', 'label', 'Still early', 'description', 'Signal density is high relative to present recognition.', 'weight', 0.09, 'enabled', true)
    )
  ),
  jsonb_build_object('minimumScore', 75, 'minimumConfidence', 0.65),
  jsonb_build_object('weeklyCandidateCount', 12),
  0.01000,
  0.10000,
  0,
  'Created the initial operational criterion.',
  '{}'::jsonb,
  now()
from public.workspaces w
where w.slug = 'unfound'
  and not exists (
    select 1
    from public.criterion_profiles active_profile
    where active_profile.workspace_id = w.id
      and active_profile.status = 'active'
  )
on conflict (workspace_id, version) do nothing;

-- SOURCE_CATALOG plus the runtime defaults in lib/discovery/config.ts.
-- Credentialless official APIs are runnable on their documented public budget.
-- Credentialed, manual, feed, and page-specific connectors remain disabled
-- until an operator supplies credentials or reviewed configuration.
with source_defaults (
  connector_key,
  name,
  kind,
  base_url,
  enabled,
  max_requests_per_run,
  discovery_config
) as (
  values
    ('github', 'GitHub repositories and collaborator graph', 'github', 'https://docs.github.com/en/rest', true, 35, '{"enabled":true,"maxItems":35,"lookbackDays":14}'::jsonb),
    ('gitlab', 'GitLab projects', 'gitlab', 'https://docs.gitlab.com/api/', true, 25, '{"enabled":true,"maxItems":25,"lookbackDays":14}'::jsonb),
    ('openalex', 'OpenAlex works and coauthor graph', 'openalex', 'https://docs.openalex.org/', true, 45, '{"enabled":true,"maxItems":45,"lookbackDays":21}'::jsonb),
    ('crossref', 'Crossref publications', 'crossref', 'https://www.crossref.org/documentation/retrieve-metadata/rest-api/', true, 35, '{"enabled":true,"maxItems":35,"lookbackDays":21}'::jsonb),
    ('arxiv', 'arXiv preprints', 'arxiv', 'https://info.arxiv.org/help/api/', true, 35, '{"enabled":true,"maxItems":35,"lookbackDays":14}'::jsonb),
    ('semantic-scholar', 'Semantic Scholar', 'semantic-scholar', 'https://api.semanticscholar.org/api-docs/graph', true, 35, '{"enabled":true,"maxItems":35,"lookbackDays":30}'::jsonb),
    ('olympiads', 'Official olympiad results', 'competition-results', 'https://www.imo-official.org/results.aspx', false, 100, '{"enabled":false,"maxItems":100}'::jsonb),
    ('science-fairs', 'Science fairs and research competitions', 'science-fairs', 'https://www.societyforscience.org/isef/', false, 100, '{"enabled":false,"maxItems":100}'::jsonb),
    ('hackathon-showcases', 'Hackathon and builder showcases', 'hackathons', 'https://devpost.com/hackathons', false, 100, '{"enabled":false,"maxItems":100}'::jsonb),
    ('codeforces', 'Codeforces contests', 'codeforces', 'https://codeforces.com/apiHelp', true, 25, '{"enabled":true,"maxItems":25,"lookbackDays":14}'::jsonb),
    ('technical-blogs', 'Technical blogs', 'technical-blogs', null, false, 60, '{"enabled":false,"maxItems":60,"urls":[]}'::jsonb),
    ('personal-sites', 'Personal sites and project pages', 'web-presence', null, true, 60, '{"enabled":true,"maxItems":60,"urls":[]}'::jsonb),
    ('project-launches', 'Project launch feeds', 'project-launches', null, false, 60, '{"enabled":false,"maxItems":60,"urls":[]}'::jsonb),
    ('hacker-news', 'Hacker News and Show HN', 'hacker-news', 'https://github.com/HackerNews/API', true, 35, '{"enabled":true,"maxItems":35,"lookbackDays":7}'::jsonb),
    ('x', 'X public graph and posts', 'x', 'https://docs.x.com/x-api', false, 30, '{"enabled":false,"maxItems":30,"queries":[]}'::jsonb),
    ('brave-enrichment', 'Public web enrichment', 'brave-enrichment', 'https://api-dashboard.search.brave.com/app/documentation/web-search/get-started', false, 8, '{"enabled":false,"maxItems":8,"options":{"maxQueries":2,"maxResults":5}}'::jsonb),
    ('linkedin', 'LinkedIn approved import', 'linkedin-manual', 'https://learn.microsoft.com/en-us/linkedin/', false, 100, '{"enabled":false,"maxItems":100}'::jsonb)
)
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
  defaults.connector_key,
  defaults.name,
  defaults.kind,
  defaults.base_url,
  case when defaults.enabled then 'active' else 'disabled' end,
  defaults.enabled,
  defaults.max_requests_per_run,
  defaults.discovery_config
from public.workspaces w
cross join source_defaults defaults
where w.slug = 'unfound'
on conflict (workspace_id, connector_key) do nothing;
