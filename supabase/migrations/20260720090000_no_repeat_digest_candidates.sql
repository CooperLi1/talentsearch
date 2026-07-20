-- Digest candidates must not repeat. The previous exclusion only counted
-- digests that were already sent, so a prepared-but-undelivered digest (or a
-- recovered missed delivery) could feature the same person twice in a row.
-- Exclude candidates from any non-failed, non-cancelled digest, dating the
-- membership by send time, scheduled time, or creation time in that order.
create or replace function public.rank_candidates_for_digest(
  p_workspace_id bigint,
  p_min_score numeric default 60,
  p_match_count integer default 20,
  p_exclude_days integer default 21
)
returns table (
  candidate_id bigint,
  slug text,
  canonical_name text,
  headline text,
  score numeric,
  momentum numeric,
  confidence numeric,
  latest_event_at timestamptz,
  digest_rank_score numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    c.id,
    c.slug,
    c.canonical_name,
    c.headline,
    c.score,
    c.momentum,
    c.confidence,
    latest.discovered_at,
    (
      c.score * 0.62
      + greatest(0, c.momentum) * 0.18
      + (c.confidence * 100) * 0.12
      + least(100, coalesce(latest.novelty_score, 0)) * 0.08
    )::numeric as digest_rank_score
  from public.candidates c
  left join lateral (
    select e.discovered_at, e.novelty_score
    from public.events e
    where e.workspace_id = c.workspace_id and e.candidate_id = c.id
    order by e.discovered_at desc, e.id desc
    limit 1
  ) latest on true
  where c.workspace_id = p_workspace_id
    and c.status in ('new', 'watching', 'saved')
    and c.score >= greatest(0, least(100, p_min_score))
    and not exists (
      select 1
      from public.digest_items di
      join public.digests d on d.workspace_id = di.workspace_id and d.id = di.digest_id
      where di.workspace_id = c.workspace_id
        and di.candidate_id = c.id
        and d.status not in ('failed', 'cancelled')
        and coalesce(d.sent_at, d.scheduled_for, d.created_at)
          >= now() - make_interval(days => greatest(0, least(365, p_exclude_days)))
    )
  order by digest_rank_score desc, latest.discovered_at desc nulls last, c.id
  limit greatest(1, least(100, p_match_count));
$$;

revoke all on function public.rank_candidates_for_digest(bigint, numeric, integer, integer) from public, anon;
grant execute on function public.rank_candidates_for_digest(bigint, numeric, integer, integer) to authenticated, service_role;
