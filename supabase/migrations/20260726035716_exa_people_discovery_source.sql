-- Add Exa as a broad, natural-language people-discovery source. It remains
-- disabled until EXA_API_KEY is configured server-side and an operator enables
-- it. Exa profiles are discovery leads; downstream sources independently
-- verify technical activity before the candidate is promoted.
insert into public.sources (
  workspace_id,
  connector_key,
  name,
  kind,
  base_url,
  status,
  enabled,
  trust_weight,
  crawl_interval_minutes,
  max_requests_per_run,
  discovery_config
)
select
  workspace.id,
  'exa-people',
  'Exa people discovery',
  'exa-people',
  'https://exa.ai/docs/reference/verticals/people',
  'disabled',
  false,
  0.6500,
  10080,
  80,
  jsonb_build_object(
    'enabled',
    false,
    'queries',
    jsonb_build_array(
      'early-career technical builders with substantial open-source projects and limited public recognition',
      'high school or undergraduate students building technically difficult software, hardware, robotics, or scientific projects',
      'open-source contributors working on compilers, databases, operating systems, developer tools, or distributed systems',
      'builders working on robotics, embedded systems, hardware, firmware, or autonomous systems',
      'researchers and builders in computational biology, bioengineering, scientific computing, or simulation',
      'security, cryptography, formal verification, programming languages, or systems researchers with public projects',
      'independent technical founders and makers who recently launched original products or open-source tools',
      'olympiad, science fair, hackathon, or fellowship participants who also build technical projects'
    ),
    'maxItems',
    80
  )
from public.workspaces workspace
on conflict (workspace_id, connector_key) do nothing;
