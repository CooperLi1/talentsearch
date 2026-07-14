update public.criterion_profiles
set thresholds = jsonb_set(
  thresholds,
  '{minimumScore}',
  to_jsonb(
    case thresholds ->> 'minimumScore'
      when '62' then 15
      when '86' then 35
      else 25
    end
  ),
  true
)
where status = 'active'
  and thresholds ->> 'minimumScore' in ('55', '62', '75', '86');
