-- A failed brief backs off for several hours, but genuinely new evidence can
-- resolve the generation or publisher-coverage failure. Requeue immediately
-- only for substantive, sufficiently confident evidence; locator hypotheses
-- must not create a model-generation loop.
create or replace function public.queue_research_from_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.candidate_id is not null then
    perform public.queue_candidate_research(new.workspace_id, new.candidate_id);

    if new.confidence >= 0.65
      and new.event_type not in (
        'profile_observed',
        'social_graph_signal',
        'identity_observed'
      ) then
      update public.candidates
      set brief_claimed_until = null
      where workspace_id = new.workspace_id
        and id = new.candidate_id
        and status <> 'archived';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.queue_research_from_event() from public, anon, authenticated;
