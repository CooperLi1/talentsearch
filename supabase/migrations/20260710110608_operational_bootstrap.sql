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
  jsonb_build_object('minimumScore', 25, 'minimumConfidence', 0.65),
  jsonb_build_object('weeklyCandidateCount', 12, 'digestCadence', 'weekly', 'digestDaysOfWeek', jsonb_build_array(1), 'digestDeliveryHourUtc', 15, 'digestDeliveryMinuteUtc', 0, 'digestPreparationLeadHours', 3),
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
  discovery_config,
  legacy_enabled,
  legacy_discovery_config
) as (
  values
    ('github', 'GitHub repositories and collaborator graph', 'github', 'https://docs.github.com/en/rest', true, 35,
      '{"enabled":true,"queries":["compiler stars:<300 size:>20","database stars:<300 size:>20","robotics stars:<300 size:>20","inference engine stars:<300 size:>20","cryptography stars:<300 size:>20","bioinformatics stars:<300 size:>20","embedded systems stars:<300 size:>20","developer tools stars:<300 size:>20"],"maxItems":35,"lookbackDays":14,"options":{"complexityKeywords":["compiler","interpreter","database","storage engine","distributed system","consensus","runtime","operating system","kernel","hypervisor","protocol","cryptography","zero knowledge","formal verification","robotics","embedded","firmware","fpga","simulation","scientific computing","bioinformatics","machine learning framework","inference engine","vector database","observability","debugger","static analysis","network stack","scheduler","query optimizer"]}}'::jsonb,
      true, '{"enabled":true,"maxItems":35,"lookbackDays":14}'::jsonb),
    ('gitlab', 'GitLab projects', 'gitlab', 'https://docs.gitlab.com/api/', true, 25,
      '{"enabled":true,"queries":["compiler","database","robotics","inference","cryptography","bioinformatics","scientific computing","developer tools"],"maxItems":25,"lookbackDays":14,"options":{"complexityKeywords":["compiler","interpreter","database","storage engine","distributed system","consensus","runtime","operating system","kernel","hypervisor","protocol","cryptography","zero knowledge","formal verification","robotics","embedded","firmware","fpga","simulation","scientific computing","bioinformatics","machine learning framework","inference engine","vector database","observability","debugger","static analysis","network stack","scheduler","query optimizer"]}}'::jsonb,
      true, '{"enabled":true,"maxItems":25,"lookbackDays":14}'::jsonb),
    ('openalex', 'OpenAlex works and coauthor graph', 'openalex', 'https://developers.openalex.org/', false, 45,
      '{"enabled":false,"queries":["efficient machine learning systems","robot learning and autonomous systems","computer security and applied cryptography","programming languages and formal methods","distributed systems and databases","computational biology and bioengineering","scientific computing and simulation","human computer interaction and assistive technology"],"maxItems":45,"lookbackDays":21}'::jsonb,
      true, '{"enabled":true,"maxItems":45,"lookbackDays":21}'::jsonb),
    ('crossref', 'Crossref publications', 'crossref', 'https://www.crossref.org/documentation/retrieve-metadata/rest-api/', true, 35,
      '{"enabled":true,"queries":["machine learning systems","robot learning and autonomous systems","computer security and applied cryptography","programming languages and formal methods","distributed systems and databases","computational biology and bioengineering","scientific computing and simulation","human computer interaction and assistive technology"],"maxItems":35,"lookbackDays":21}'::jsonb,
      true, '{"enabled":true,"maxItems":35,"lookbackDays":21}'::jsonb),
    ('arxiv', 'arXiv preprints', 'arxiv', 'https://info.arxiv.org/help/api/', true, 35,
      '{"enabled":true,"queries":["cat:cs.AI OR cat:cs.LG","cat:cs.RO","cat:cs.CR","cat:cs.DC OR cat:cs.OS","cat:cs.PL OR cat:cs.SE","cat:cs.AR","cat:q-bio.QM OR cat:q-bio.BM","cat:physics.comp-ph OR cat:eess.SY"],"maxItems":35,"lookbackDays":14}'::jsonb,
      true, '{"enabled":true,"maxItems":35,"lookbackDays":14}'::jsonb),
    ('semantic-scholar', 'Semantic Scholar', 'semantic-scholar', 'https://api.semanticscholar.org/api-docs/graph', true, 35,
      '{"enabled":true,"queries":["machine learning systems","robot learning and autonomous systems","computer security and applied cryptography","programming languages and formal methods","distributed systems and databases","computational biology and bioengineering","scientific computing and simulation","human computer interaction and assistive technology"],"maxItems":35,"lookbackDays":30}'::jsonb,
      true, '{"enabled":true,"maxItems":35,"lookbackDays":30}'::jsonb),
    ('olympiads', 'Official olympiad results', 'competition-results', 'https://www.imo-official.org/results.aspx', true, 100,
      '{"enabled":true,"maxItems":100,"options":{"pages":[{"url":"https://www.imo-official.org/results/individual/year/2025/","itemSelector":".data-table-wrapper table[data-results-anomaly-table] tbody > tr","nameSelector":"[data-person-name]","rankSelector":"td:nth-child(3)","affiliationSelector":".data-table__country-full","linkSelector":"td:first-child a","titleSelector":"td:nth-child(4)","eventName":"International Mathematical Olympiad 2025","eventType":"competition_result","occurredAt":"2025-07-20"},{"url":"https://www.icho-official.org/results/results.php?id=57&year=2025","itemSelector":".table-responsive tbody tr","nameSelector":"td:nth-child(1)","affiliationSelector":"td:nth-child(3)","rankSelector":"td:nth-child(4)","titleSelector":"td:nth-child(5)","eventName":"International Chemistry Olympiad 2025","eventType":"competition_result","occurredAt":"2025-07-14T00:00:00.000Z"}]}}'::jsonb,
      false, '{"enabled":false,"maxItems":100}'::jsonb),
    ('science-fairs', 'Science fairs and research competitions', 'science-fairs', 'https://www.societyforscience.org/isef/', false, 100,
      '{"enabled":false,"maxItems":100}'::jsonb,
      false, '{"enabled":false,"maxItems":100}'::jsonb),
    ('hackathon-showcases', 'Hackathon and builder showcases', 'hackathons', 'https://devpost.com/hackathons', false, 100,
      '{"enabled":false,"maxItems":100}'::jsonb,
      false, '{"enabled":false,"maxItems":100}'::jsonb),
    ('codeforces', 'Codeforces contests', 'codeforces', 'https://codeforces.com/apiHelp', true, 25,
      '{"enabled":true,"maxItems":25,"lookbackDays":14}'::jsonb,
      true, '{"enabled":true,"maxItems":25,"lookbackDays":14}'::jsonb),
    ('technical-blogs', 'Technical blogs', 'technical-blogs', null, true, 60,
      '{"enabled":true,"maxItems":60,"urls":["https://github.blog/feed/","https://hacks.mozilla.org/feed/","https://blog.cloudflare.com/rss/","https://projectzero.google/feed.xml","https://about.gitlab.com/atom.xml"]}'::jsonb,
      false, '{"enabled":false,"maxItems":60,"urls":[]}'::jsonb),
    ('personal-sites', 'Personal sites and project pages', 'web-presence', null, true, 60,
      '{"enabled":true,"maxItems":60,"urls":[]}'::jsonb,
      true, '{"enabled":true,"maxItems":60,"urls":[]}'::jsonb),
    ('project-launches', 'Project launch feeds', 'project-launches', null, false, 60,
      '{"enabled":false,"maxItems":60,"urls":[]}'::jsonb,
      false, '{"enabled":false,"maxItems":60,"urls":[]}'::jsonb),
    ('hacker-news', 'Hacker News and Show HN', 'hacker-news', 'https://github.com/HackerNews/API', true, 35,
      '{"enabled":true,"maxItems":35,"lookbackDays":7,"options":{"feed":"showstories","minimumScore":2,"topicKeywords":["compiler","database","distributed systems","robotics","embedded","hardware","machine learning","inference","security","cryptography","formal verification","bioinformatics","scientific computing","developer tools","open source","protocol","simulation","programming language","operating system"],"requireTopicMatch":false}}'::jsonb,
      true, '{"enabled":true,"maxItems":35,"lookbackDays":7}'::jsonb),
    ('x', 'X public graph and posts', 'x', 'https://docs.x.com/x-api', false, 30,
      '{"enabled":false,"maxItems":30,"queries":["(\"open sourced\" OR \"I built\" OR \"I made\") (compiler OR database OR robotics OR hardware)","(\"open sourced\" OR \"I built\") (inference OR model OR agent OR benchmark)","(paper OR preprint) (cryptography OR bioinformatics OR robotics OR systems)","(won OR finalist OR medalist) (olympiad OR hackathon OR \"science fair\")","(\"looking for contributors\" OR \"first release\" OR \"v0.1\") (github OR gitlab)"]}'::jsonb,
      false, '{"enabled":false,"maxItems":30,"queries":[]}'::jsonb),
    ('brave-enrichment', 'Public web enrichment', 'brave-enrichment', 'https://api-dashboard.search.brave.com/app/documentation/web-search/get-started', false, 8,
      '{"enabled":false,"maxItems":8,"options":{"maxQueries":4,"maxResults":8}}'::jsonb,
      false, '{"enabled":false,"maxItems":8,"options":{"maxQueries":4,"maxResults":8}}'::jsonb),
    ('linkedin', 'LinkedIn approved import', 'linkedin-manual', 'https://learn.microsoft.com/en-us/linkedin/', false, 100,
      '{"enabled":false,"maxItems":100}'::jsonb,
      false, '{"enabled":false,"maxItems":100}'::jsonb)
),
upgraded_untouched_defaults as (
  update public.sources existing
  set
    base_url = defaults.base_url,
    status = case when defaults.enabled then 'active' else 'disabled' end,
    enabled = defaults.enabled,
    discovery_config = defaults.discovery_config
  from public.workspaces workspace, source_defaults defaults
  where workspace.slug = 'unfound'
    and existing.workspace_id = workspace.id
    and existing.connector_key = defaults.connector_key
    and existing.name = defaults.name
    and existing.kind = defaults.kind
    and existing.base_url is not distinct from case
      when defaults.connector_key = 'openalex' then 'https://docs.openalex.org/'
      else defaults.base_url
    end
    and existing.status = case when defaults.legacy_enabled then 'active' else 'disabled' end
    and existing.enabled = defaults.legacy_enabled
    and existing.max_requests_per_run = defaults.max_requests_per_run
    and existing.discovery_config = defaults.legacy_discovery_config
  returning existing.id
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
