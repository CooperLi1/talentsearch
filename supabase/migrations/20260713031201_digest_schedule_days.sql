update public.criterion_profiles
set digest_config = digest_config
  || jsonb_build_object(
    'digestDaysOfWeek', coalesce(digest_config -> 'digestDaysOfWeek', '[1]'::jsonb),
    'digestDeliveryMinuteUtc', coalesce(digest_config -> 'digestDeliveryMinuteUtc', '0'::jsonb),
    'digestPreparationLeadHours', coalesce(digest_config -> 'digestPreparationLeadHours', '3'::jsonb)
  );
