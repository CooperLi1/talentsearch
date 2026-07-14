-- Add the Hugging Face Hub to every existing workspace. It remains disabled
-- until an operator reviews the public-profile identity quality and enables it.
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
  'hugging-face',
  'Hugging Face Hub',
  'hugging-face',
  'https://huggingface.co/docs/hub/api',
  'disabled',
  false,
  0.7000,
  10080,
  45,
  '{"enabled":false,"queries":["robotics","compiler","scientific computing","computer vision","reinforcement learning","bioinformatics","speech technology","developer tools"],"maxItems":45,"lookbackDays":30}'::jsonb
from public.workspaces workspace
on conflict (workspace_id, connector_key) do nothing;
