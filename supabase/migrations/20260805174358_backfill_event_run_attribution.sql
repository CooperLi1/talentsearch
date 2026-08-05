-- Historical events were written without their ingestion run even though their
-- discovery timestamp was generated from that run's start time. Only repair
-- rows with exactly one possible run; ambiguous rows remain null for review.
with unique_run_matches as (
  select
    event.id as event_id,
    min(run.id) as run_id
  from public.events as event
  join public.ingestion_runs as run
    on run.workspace_id = event.workspace_id
   and run.started_at = event.discovered_at
  where event.run_id is null
  group by event.id
  having count(*) = 1
)
update public.events as event
set run_id = match.run_id
from unique_run_matches as match
where event.id = match.event_id
  and event.run_id is null;
