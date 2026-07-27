-- The direct model provider exhausted its quota while operator-v39 briefs were
-- being regenerated. Those failures left stale-policy candidates in six-hour
-- retry windows. Once direct provider quota is restored, release only
-- stale-policy claims so the safe, database-claimed backfill can resume
-- immediately.
update public.candidates
set brief_claimed_until = null
where brief_prompt_version is distinct from 'operator-v39'
  and brief_claimed_until is not null;
