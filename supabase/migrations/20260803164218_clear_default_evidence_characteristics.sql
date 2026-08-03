update public.criterion_profiles
set thresholds = jsonb_set(thresholds, '{characteristics}', '[]'::jsonb, true)
where status = 'active'
  and thresholds -> 'characteristics' is null;
