-- Project-count inflation was removed from scoring, so move the active
-- workspace to the new balanced cutoff. Operators can still choose broad or
-- selective presets in Settings.

update public.criterion_profiles
set thresholds = jsonb_set(thresholds, '{minimumScore}', '18'::jsonb, true),
    change_summary = 'Recalibrated to corrected evidence-quality scoring',
    updated_at = now()
where status = 'active';
