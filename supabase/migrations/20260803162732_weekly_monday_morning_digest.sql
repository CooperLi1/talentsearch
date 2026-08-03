update public.criterion_profiles
set digest_config = digest_config || jsonb_build_object(
  'digestCadence', 'weekly',
  'digestDaysOfWeek', jsonb_build_array(1),
  'digestDeliveryHourUtc', 15,
  'digestDeliveryMinuteUtc', 0
)
where status = 'active'
  and (
    digest_config ->> 'digestCadence' is distinct from 'weekly'
    or digest_config -> 'digestDaysOfWeek' is distinct from '[1]'::jsonb
    or digest_config ->> 'digestDeliveryHourUtc' is distinct from '15'
    or digest_config ->> 'digestDeliveryMinuteUtc' is distinct from '0'
  );
