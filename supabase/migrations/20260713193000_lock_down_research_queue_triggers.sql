-- Trigger functions are internal implementation details. PostgreSQL grants
-- function execution to PUBLIC by default, which would otherwise expose these
-- SECURITY DEFINER functions as PostgREST RPCs.
revoke all on function public.queue_research_from_candidate_profile()
  from public, anon, authenticated;
revoke all on function public.queue_research_from_event()
  from public, anon, authenticated;
revoke all on function public.queue_research_from_identity()
  from public, anon, authenticated;
revoke all on function public.queue_research_from_identity_candidate()
  from public, anon, authenticated;
