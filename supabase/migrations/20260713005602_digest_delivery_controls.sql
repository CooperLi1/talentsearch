-- Existing workspaces default to the original Monday cadence. Operators can
-- change it from Settings; profiles that already carry a value are preserved.
update public.criterion_profiles
set digest_config = jsonb_set(digest_config, '{digestCadence}', '"weekly"'::jsonb, true)
where not (digest_config ? 'digestCadence');
