alter table public.candidates
  add column if not exists research_input_revision integer not null default 0
    check (research_input_revision >= 0),
  add column if not exists research_completed_revision integer not null default 0
    check (research_completed_revision >= 0);

create or replace function public.queue_candidate_research(
  p_workspace_id bigint,
  p_candidate_id bigint
)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.candidates
  set research_input_revision = research_input_revision + 1,
      enrichment_next_at = least(
        coalesce(enrichment_next_at, clock_timestamp()),
        clock_timestamp()
      )
  where workspace_id = p_workspace_id
    and id = p_candidate_id
    and status <> 'archived';
$$;

create or replace function public.queue_research_from_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.candidate_id is not null then
    perform public.queue_candidate_research(new.workspace_id, new.candidate_id);
  end if;
  return new;
end;
$$;

drop trigger if exists events_queue_candidate_research on public.events;
create trigger events_queue_candidate_research
after insert on public.events
for each row execute function public.queue_research_from_event();

create or replace function public.queue_research_from_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.candidate_id is not null then
      perform public.queue_candidate_research(new.workspace_id, new.candidate_id);
    end if;
  elsif new.candidate_id is distinct from old.candidate_id
     or new.provider_subject_id is distinct from old.provider_subject_id
     or new.handle is distinct from old.handle
     or new.profile_url is distinct from old.profile_url
     or new.resolution_status is distinct from old.resolution_status then
    if old.candidate_id is not null then
      perform public.queue_candidate_research(old.workspace_id, old.candidate_id);
    end if;
    if new.candidate_id is not null then
      perform public.queue_candidate_research(new.workspace_id, new.candidate_id);
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists identities_queue_candidate_research on public.identities;
create trigger identities_queue_candidate_research
after insert or update on public.identities
for each row execute function public.queue_research_from_identity();

create or replace function public.queue_research_from_identity_candidate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT'
     or new.decision is distinct from old.decision
     or new.identity_id is distinct from old.identity_id then
    perform public.queue_candidate_research(new.workspace_id, new.candidate_id);
  end if;
  return new;
end;
$$;

drop trigger if exists identity_candidates_queue_candidate_research on public.identity_candidates;
create trigger identity_candidates_queue_candidate_research
after insert or update on public.identity_candidates
for each row execute function public.queue_research_from_identity_candidate();

create or replace function public.queue_research_from_candidate_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.attributes -> 'alternateNames' is distinct from old.attributes -> 'alternateNames'
     or new.attributes -> 'websiteUrl' is distinct from old.attributes -> 'websiteUrl'
     or new.attributes -> 'affiliations' is distinct from old.attributes -> 'affiliations' then
    perform public.queue_candidate_research(new.workspace_id, new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists candidates_queue_profile_research on public.candidates;
create trigger candidates_queue_profile_research
after update of attributes on public.candidates
for each row execute function public.queue_research_from_candidate_profile();

drop function if exists public.claim_candidate_enrichment_batch(bigint, integer, integer);
create function public.claim_candidate_enrichment_batch(
  p_workspace_id bigint,
  p_match_count integer default 5,
  p_claim_seconds integer default 360
)
returns table(candidate_id bigint, research_pass integer, research_revision integer)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  return query
  with eligible as (
    select
      candidates.id,
      candidates.enrichment_attempt_count,
      candidates.research_input_revision
    from public.candidates as candidates
    where candidates.workspace_id = p_workspace_id
      and candidates.status <> 'archived'
      and (
        candidates.enrichment_next_at is null
        or candidates.enrichment_next_at <= clock_timestamp()
        or candidates.research_input_revision > candidates.research_completed_revision
      )
      and (
        candidates.enrichment_claimed_until is null
        or candidates.enrichment_claimed_until < clock_timestamp()
      )
      and exists (
        select 1
        from public.identities
        where identities.workspace_id = p_workspace_id
          and identities.candidate_id = candidates.id
          and identities.resolution_status = 'resolved'
      )
    order by
      least(candidates.enrichment_attempt_count, 3) asc,
      (candidates.research_input_revision > candidates.research_completed_revision) desc,
      candidates.score desc,
      candidates.source_count asc,
      candidates.enrichment_attempted_at asc nulls first,
      candidates.id asc
    for update of candidates skip locked
    limit greatest(1, least(coalesce(p_match_count, 5), 20))
  ), claimed as (
    update public.candidates as candidates
    set enrichment_claimed_until = clock_timestamp() + make_interval(
      secs => greatest(120, least(coalesce(p_claim_seconds, 360), 900))
    )
    from eligible
    where candidates.id = eligible.id
      and candidates.workspace_id = p_workspace_id
    returning
      candidates.id,
      eligible.enrichment_attempt_count,
      eligible.research_input_revision
  )
  select claimed.id, claimed.enrichment_attempt_count, claimed.research_input_revision
  from claimed;
end;
$$;

drop function if exists public.complete_candidate_enrichment_attempt(
  bigint,
  bigint,
  integer,
  timestamptz
);
create function public.complete_candidate_enrichment_attempt(
  p_workspace_id bigint,
  p_candidate_id bigint,
  p_event_count integer,
  p_attempted_at timestamptz,
  p_research_revision integer
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  next_attempt_count integer;
  current_research_revision integer;
begin
  select
    candidates.enrichment_attempt_count + 1,
    candidates.research_input_revision
  into next_attempt_count, current_research_revision
  from public.candidates as candidates
  where candidates.workspace_id = p_workspace_id
    and candidates.id = p_candidate_id
  for update;

  if next_attempt_count is null then
    raise exception 'Candidate not found';
  end if;

  update public.candidates as candidates
  set enrichment_attempt_count = next_attempt_count,
      enrichment_attempted_at = p_attempted_at,
      enrichment_result_count = greatest(0, coalesce(p_event_count, 0)),
      enrichment_claimed_until = null,
      research_completed_revision = greatest(
        candidates.research_completed_revision,
        greatest(0, coalesce(p_research_revision, 0))
      ),
      enrichment_next_at = case
        when current_research_revision > greatest(0, coalesce(p_research_revision, 0))
          then clock_timestamp()
        else p_attempted_at + case
          when next_attempt_count < 3 then interval '4 hours'
          when coalesce(p_event_count, 0) > 0 then interval '7 days'
          else interval '30 days'
        end
      end
  where candidates.workspace_id = p_workspace_id
    and candidates.id = p_candidate_id;
end;
$$;

revoke all on function public.queue_candidate_research(bigint, bigint)
  from public, anon, authenticated;
revoke all on function public.claim_candidate_enrichment_batch(bigint, integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_candidate_enrichment_batch(bigint, integer, integer)
  to service_role;
revoke all on function public.complete_candidate_enrichment_attempt(bigint, bigint, integer, timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.complete_candidate_enrichment_attempt(bigint, bigint, integer, timestamptz, integer)
  to service_role;

-- Existing candidates need one pass under the new research contract. This also
-- ensures every candidate receives Brave enrichment, rather than waiting on a
-- legacy weekly retry date.
update public.candidates
set research_input_revision = greatest(research_input_revision, 1),
    research_completed_revision = 0,
    enrichment_attempt_count = 0,
    enrichment_next_at = clock_timestamp(),
    enrichment_claimed_until = null
where status <> 'archived';

-- Regenerate briefs under the pitch-first evidence contract.
do $migration$
declare
  definition text;
begin
  select pg_get_functiondef(
    'public.claim_candidate_brief_batch(bigint,integer,integer)'::regprocedure
  ) into definition;
  execute replace(definition, 'operator-v14', 'operator-v15');
end;
$migration$;
