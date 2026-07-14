update public.criterion_profiles
set digest_config = jsonb_set(digest_config, '{digestDeliveryHourUtc}', '15'::jsonb, true)
where not (digest_config ? 'digestDeliveryHourUtc');
