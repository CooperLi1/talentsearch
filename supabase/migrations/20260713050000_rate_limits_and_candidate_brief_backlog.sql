-- Shared API throttling and a durable, evidence-driven candidate briefing backlog.

create schema if not exists private;

create table if not exists private.api_rate_limits (
  bucket text not null,
  key_hash text not null,
  window_started_at timestamptz not null,
  request_count integer not null default 1,
  primary key (bucket, key_hash, window_started_at),
  constraint api_rate_limits_bucket_not_blank check (btrim(bucket) <> ''),
  constraint api_rate_limits_key_not_blank check (btrim(key_hash) <> ''),
  constraint api_rate_limits_count_positive check (request_count > 0)
);

alter table private.api_rate_limits enable row level security;
revoke all on table private.api_rate_limits from public, anon, authenticated;
grant usage on schema private to service_role;
grant select, insert, update, delete on table private.api_rate_limits to service_role;

create index if not exists api_rate_limits_window_idx
  on private.api_rate_limits (window_started_at);

create or replace function public.consume_api_rate_limit(
  p_bucket text,
  p_key_hash text,
  p_limit integer,
  p_window_seconds integer
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_window_started_at timestamptz;
  v_count integer;
  v_limit integer := greatest(1, least(coalesce(p_limit, 1), 10000));
  v_window_seconds integer := greatest(1, least(coalesce(p_window_seconds, 60), 86400));
begin
  if btrim(coalesce(p_bucket, '')) = '' or btrim(coalesce(p_key_hash, '')) = '' then
    raise exception 'Rate limit bucket and key are required';
  end if;

  v_window_started_at := to_timestamp(
    floor(extract(epoch from v_now) / v_window_seconds) * v_window_seconds
  );

  insert into private.api_rate_limits as limits (
    bucket,
    key_hash,
    window_started_at,
    request_count
  ) values (
    left(p_bucket, 120),
    left(p_key_hash, 128),
    v_window_started_at,
    1
  )
  on conflict (bucket, key_hash, window_started_at)
  do update set request_count = limits.request_count + 1
  returning request_count into v_count;

  delete from private.api_rate_limits
  where window_started_at < v_now - interval '2 days';

  return jsonb_build_object(
    'allowed', v_count <= v_limit,
    'limit', v_limit,
    'remaining', greatest(0, v_limit - v_count),
    'resetAt', (v_window_started_at + make_interval(secs => v_window_seconds)),
    'retryAfterSeconds', greatest(
      1,
      ceil(extract(epoch from (v_window_started_at + make_interval(secs => v_window_seconds) - v_now)))::integer
    )
  );
end;
$$;

revoke all on function public.consume_api_rate_limit(text, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.consume_api_rate_limit(text, text, integer, integer)
  to service_role;

alter table public.candidates
  add column if not exists brief_evidence_fingerprint text,
  add column if not exists brief_generated_at timestamptz,
  add column if not exists brief_model text,
  add column if not exists brief_claimed_until timestamptz;

create index if not exists candidates_brief_backlog_idx
  on public.candidates (workspace_id, brief_generated_at, id)
  where status <> 'archived';

create or replace function public.claim_candidate_brief_batch(
  p_workspace_id bigint,
  p_match_count integer default 12,
  p_claim_seconds integer default 300
)
returns table(candidate_id bigint, evidence_fingerprint text)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  return query
  with substantive as (
    select
      events.candidate_id,
      md5(string_agg(events.content_hash, ',' order by events.discovered_at, events.id)) as fingerprint,
      max(events.discovered_at) as latest_evidence_at
    from public.events
    where events.workspace_id = p_workspace_id
      and events.event_type not in ('profile_observed', 'social_graph_signal')
      and events.confidence >= 0.65
    group by events.candidate_id
    having count(distinct events.content_hash) >= 2
  ), eligible as (
    select candidates.id, substantive.fingerprint
    from public.candidates
    join substantive on substantive.candidate_id = candidates.id
    where candidates.workspace_id = p_workspace_id
      and candidates.status <> 'archived'
      and exists (
        select 1
        from public.identities
        where identities.workspace_id = candidates.workspace_id
          and identities.candidate_id = candidates.id
          and identities.resolution_status = 'resolved'
      )
      and candidates.brief_evidence_fingerprint is distinct from substantive.fingerprint
      and (
        candidates.brief_claimed_until is null
        or candidates.brief_claimed_until < clock_timestamp()
      )
    order by candidates.brief_generated_at asc nulls first,
      substantive.latest_evidence_at desc,
      candidates.id asc
    for update of candidates skip locked
    limit greatest(1, least(coalesce(p_match_count, 12), 50))
  ), claimed as (
    update public.candidates as candidates
    set brief_claimed_until = clock_timestamp() + make_interval(
      secs => greatest(60, least(coalesce(p_claim_seconds, 300), 1800))
    )
    from eligible
    where candidates.id = eligible.id
      and candidates.workspace_id = p_workspace_id
    returning candidates.id, eligible.fingerprint
  )
  select claimed.id, claimed.fingerprint
  from claimed;
end;
$$;

revoke all on function public.claim_candidate_brief_batch(bigint, integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_candidate_brief_batch(bigint, integer, integer)
  to service_role;
