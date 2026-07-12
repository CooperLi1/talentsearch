-- Talent Radar: workspace-isolated discovery, evidence, graph, ranking, and digest data.
-- Embeddings use OpenAI text-embedding-3-small's default 1,536 dimensions.

create extension if not exists vector with schema extensions;
grant usage on schema extensions to authenticated, service_role;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- PostgreSQL marks the polymorphic array_to_string(anyarray, ...) function as
-- STABLE because some element output functions depend on session settings. For
-- text[] specifically the result is immutable, so expose the narrow wrapper
-- needed by the stored generated search vector.
create or replace function private.text_array_to_search_text(value text[])
returns text
language sql
immutable
strict
security invoker
set search_path = ''
as $$
  select pg_catalog.array_to_string(value, ' ');
$$;

revoke all on function private.text_array_to_search_text(text[]) from public, anon, authenticated, service_role;

create table public.workspaces (
  id bigint generated always as identity primary key,
  slug text not null,
  name text not null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspaces_slug_format check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  constraint workspaces_name_not_blank check (btrim(name) <> ''),
  constraint workspaces_slug_unique unique (slug)
);

create table public.workspace_members (
  workspace_id bigint not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'viewer',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, user_id),
  constraint workspace_members_role_valid check (role in ('owner', 'admin', 'scout', 'viewer'))
);

create table public.sources (
  id bigint generated always as identity primary key,
  workspace_id bigint not null references public.workspaces (id) on delete cascade,
  connector_key text not null,
  name text not null,
  kind text not null,
  base_url text,
  status text not null default 'active',
  enabled boolean not null default true,
  trust_weight numeric(5,4) not null default 0.7500,
  crawl_interval_minutes integer not null default 1440,
  max_requests_per_run integer not null default 250,
  discovery_config jsonb not null default '{}'::jsonb,
  health_metadata jsonb not null default '{}'::jsonb,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  next_run_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sources_workspace_id_id_unique unique (workspace_id, id),
  constraint sources_workspace_connector_unique unique (workspace_id, connector_key),
  constraint sources_connector_key_format check (connector_key ~ '^[a-z0-9][a-z0-9_-]*$'),
  constraint sources_name_not_blank check (btrim(name) <> ''),
  constraint sources_kind_not_blank check (btrim(kind) <> ''),
  constraint sources_status_valid check (status in ('active', 'paused', 'degraded', 'disabled')),
  constraint sources_trust_weight_range check (trust_weight between 0 and 1),
  constraint sources_crawl_interval_positive check (crawl_interval_minutes between 5 and 525600),
  constraint sources_request_limit_positive check (max_requests_per_run between 1 and 100000),
  constraint sources_discovery_config_object check (jsonb_typeof(discovery_config) = 'object'),
  constraint sources_health_metadata_object check (jsonb_typeof(health_metadata) = 'object')
);

create table public.discovery_seeds (
  id bigint generated always as identity primary key,
  workspace_id bigint not null references public.workspaces (id) on delete cascade,
  source_id bigint,
  seed_type text not null,
  provider text not null,
  external_id text,
  url text,
  label text not null,
  max_depth smallint not null default 2,
  weight numeric(5,4) not null default 1,
  enabled boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint discovery_seeds_workspace_id_id_unique unique (workspace_id, id),
  constraint discovery_seeds_source_fk foreign key (workspace_id, source_id)
    references public.sources (workspace_id, id) on delete cascade,
  constraint discovery_seeds_type_valid check (seed_type in ('person', 'organization', 'project', 'competition', 'topic', 'feed', 'query')),
  constraint discovery_seeds_provider_not_blank check (btrim(provider) <> ''),
  constraint discovery_seeds_label_not_blank check (btrim(label) <> ''),
  constraint discovery_seeds_depth_range check (max_depth between 0 and 4),
  constraint discovery_seeds_weight_range check (weight between 0 and 5),
  constraint discovery_seeds_locator_present check (external_id is not null or url is not null),
  constraint discovery_seeds_metadata_object check (jsonb_typeof(metadata) = 'object')
);

create table public.ingestion_runs (
  id bigint generated always as identity primary key,
  workspace_id bigint not null references public.workspaces (id) on delete cascade,
  source_id bigint,
  parent_run_id bigint,
  run_kind text not null default 'scheduled',
  status text not null default 'queued',
  scheduled_for timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  heartbeat_at timestamptz,
  attempt smallint not null default 1,
  discovered_count integer not null default 0,
  enriched_count integer not null default 0,
  event_count integer not null default 0,
  error_count integer not null default 0,
  cursor jsonb not null default '{}'::jsonb,
  metrics jsonb not null default '{}'::jsonb,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  constraint ingestion_runs_workspace_id_id_unique unique (workspace_id, id),
  constraint ingestion_runs_source_fk foreign key (workspace_id, source_id)
    references public.sources (workspace_id, id) on delete set null (source_id),
  constraint ingestion_runs_parent_fk foreign key (workspace_id, parent_run_id)
    references public.ingestion_runs (workspace_id, id) on delete set null (parent_run_id),
  constraint ingestion_runs_kind_valid check (run_kind in ('scheduled', 'manual', 'enrichment', 'graph_expansion', 'backfill', 'retry')),
  constraint ingestion_runs_status_valid check (status in ('queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled')),
  constraint ingestion_runs_attempt_positive check (attempt between 1 and 25),
  constraint ingestion_runs_counts_nonnegative check (
    discovered_count >= 0 and enriched_count >= 0 and event_count >= 0 and error_count >= 0
  ),
  constraint ingestion_runs_time_order check (finished_at is null or started_at is null or finished_at >= started_at),
  constraint ingestion_runs_cursor_object check (jsonb_typeof(cursor) = 'object'),
  constraint ingestion_runs_metrics_object check (jsonb_typeof(metrics) = 'object')
);

create table public.candidates (
  id bigint generated always as identity primary key,
  workspace_id bigint not null references public.workspaces (id) on delete cascade,
  slug text not null,
  canonical_name text not null,
  sort_name text not null,
  headline text,
  location text,
  stage text,
  school text,
  avatar_url text,
  domains text[] not null default '{}',
  status text not null default 'new',
  score numeric(6,3) not null default 0,
  momentum numeric(7,3) not null default 0,
  confidence numeric(5,4) not null default 0,
  source_count integer not null default 0,
  summary_md text not null default '',
  why_now_md text not null default '',
  earlyness_md text not null default '',
  score_components jsonb not null default '{}'::jsonb,
  attributes jsonb not null default '{}'::jsonb,
  search_text text not null default '',
  search_vector tsvector generated always as (
    to_tsvector(
      'english',
      coalesce(canonical_name, '') || ' ' ||
      coalesce(headline, '') || ' ' ||
      coalesce(school, '') || ' ' ||
      coalesce(private.text_array_to_search_text(domains), '') || ' ' ||
      coalesce(search_text, '') || ' ' ||
      coalesce(summary_md, '')
    )
  ) stored,
  embedding extensions.vector(1536),
  embedding_model text,
  embedding_updated_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint candidates_workspace_id_id_unique unique (workspace_id, id),
  constraint candidates_workspace_slug_unique unique (workspace_id, slug),
  constraint candidates_slug_format check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  constraint candidates_name_not_blank check (btrim(canonical_name) <> '' and btrim(sort_name) <> ''),
  constraint candidates_status_valid check (status in ('new', 'watching', 'saved', 'contacted', 'interviewing', 'fellow', 'passed', 'archived')),
  constraint candidates_score_range check (score between 0 and 100),
  constraint candidates_momentum_range check (momentum between -100 and 100),
  constraint candidates_confidence_range check (confidence between 0 and 1),
  constraint candidates_source_count_nonnegative check (source_count >= 0),
  constraint candidates_score_components_object check (jsonb_typeof(score_components) = 'object'),
  constraint candidates_attributes_object check (jsonb_typeof(attributes) = 'object'),
  constraint candidates_seen_time_order check (last_seen_at >= first_seen_at),
  constraint candidates_embedding_metadata check (
    (embedding is null and embedding_model is null and embedding_updated_at is null)
    or (embedding is not null and embedding_model is not null and embedding_updated_at is not null)
  )
);

-- A normalized name is deliberately not unique. Provider IDs and evidence resolve identity;
-- same-name observations can remain ambiguous and point at multiple candidate hypotheses.
create table public.identities (
  id bigint generated always as identity primary key,
  workspace_id bigint not null references public.workspaces (id) on delete cascade,
  candidate_id bigint,
  provider text not null,
  provider_subject_id text,
  handle text,
  profile_url text,
  display_name text not null,
  normalized_name text not null,
  resolution_status text not null default 'unresolved',
  ambiguity_key text,
  match_confidence numeric(5,4) not null default 0,
  match_method text,
  distinguishing_facts jsonb not null default '{}'::jsonb,
  evidence jsonb not null default '[]'::jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint identities_workspace_id_id_unique unique (workspace_id, id),
  constraint identities_candidate_fk foreign key (workspace_id, candidate_id)
    references public.candidates (workspace_id, id) on delete set null (candidate_id),
  constraint identities_provider_not_blank check (btrim(provider) <> ''),
  constraint identities_names_not_blank check (btrim(display_name) <> '' and btrim(normalized_name) <> ''),
  constraint identities_resolution_valid check (resolution_status in ('unresolved', 'ambiguous', 'resolved', 'rejected')),
  constraint identities_confidence_range check (match_confidence between 0 and 1),
  constraint identities_facts_object check (jsonb_typeof(distinguishing_facts) = 'object'),
  constraint identities_evidence_array check (jsonb_typeof(evidence) = 'array'),
  constraint identities_seen_time_order check (last_seen_at >= first_seen_at),
  constraint identities_resolved_candidate_present check (resolution_status <> 'resolved' or candidate_id is not null)
);

create table public.identity_candidates (
  workspace_id bigint not null references public.workspaces (id) on delete cascade,
  identity_id bigint not null,
  candidate_id bigint not null,
  match_score numeric(5,4) not null,
  decision text not null default 'proposed',
  signals jsonb not null default '{}'::jsonb,
  reviewed_by uuid references auth.users (id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (identity_id, candidate_id),
  constraint identity_candidates_identity_fk foreign key (workspace_id, identity_id)
    references public.identities (workspace_id, id) on delete cascade,
  constraint identity_candidates_candidate_fk foreign key (workspace_id, candidate_id)
    references public.candidates (workspace_id, id) on delete cascade,
  constraint identity_candidates_score_range check (match_score between 0 and 1),
  constraint identity_candidates_decision_valid check (decision in ('proposed', 'accepted', 'rejected')),
  constraint identity_candidates_signals_object check (jsonb_typeof(signals) = 'object'),
  constraint identity_candidates_review_consistent check (
    (decision = 'proposed' and reviewed_at is null)
    or (decision <> 'proposed' and reviewed_at is not null)
  )
);

create table public.events (
  id bigint generated always as identity primary key,
  workspace_id bigint not null references public.workspaces (id) on delete cascade,
  candidate_id bigint not null,
  source_id bigint,
  run_id bigint,
  event_type text not null,
  title text not null,
  summary_md text not null default '',
  why_it_matters_md text not null default '',
  occurred_at timestamptz,
  discovered_at timestamptz not null default now(),
  source_url text not null,
  source_label text not null,
  external_id text,
  content_hash text not null,
  evidence_excerpt text,
  confidence numeric(5,4) not null default 0.5,
  novelty_score numeric(6,3) not null default 0,
  significance_score numeric(6,3) not null default 0,
  raw_payload jsonb not null default '{}'::jsonb,
  llm_model text,
  prompt_version text,
  embedding extensions.vector(1536),
  embedding_model text,
  embedding_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint events_workspace_id_id_unique unique (workspace_id, id),
  constraint events_candidate_fk foreign key (workspace_id, candidate_id)
    references public.candidates (workspace_id, id) on delete cascade,
  constraint events_source_fk foreign key (workspace_id, source_id)
    references public.sources (workspace_id, id) on delete set null (source_id),
  constraint events_run_fk foreign key (workspace_id, run_id)
    references public.ingestion_runs (workspace_id, id) on delete set null (run_id),
  constraint events_type_not_blank check (btrim(event_type) <> ''),
  constraint events_title_not_blank check (btrim(title) <> ''),
  constraint events_source_not_blank check (btrim(source_url) <> '' and btrim(source_label) <> ''),
  constraint events_hash_format check (content_hash ~ '^[a-f0-9]{64}$'),
  constraint events_confidence_range check (confidence between 0 and 1),
  constraint events_novelty_range check (novelty_score between 0 and 100),
  constraint events_significance_range check (significance_score between 0 and 100),
  constraint events_raw_payload_object check (jsonb_typeof(raw_payload) = 'object'),
  constraint events_embedding_metadata check (
    (embedding is null and embedding_model is null and embedding_updated_at is null)
    or (embedding is not null and embedding_model is not null and embedding_updated_at is not null)
  )
);

create table public.event_evidence (
  id bigint generated always as identity primary key,
  workspace_id bigint not null references public.workspaces (id) on delete cascade,
  event_id bigint not null,
  url text not null,
  label text not null,
  excerpt text,
  evidence_kind text not null default 'primary',
  published_at timestamptz,
  retrieved_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  constraint event_evidence_event_fk foreign key (workspace_id, event_id)
    references public.events (workspace_id, id) on delete cascade,
  constraint event_evidence_url_not_blank check (btrim(url) <> '' and btrim(label) <> ''),
  constraint event_evidence_kind_valid check (evidence_kind in ('primary', 'corroborating', 'social', 'archive')),
  constraint event_evidence_metadata_object check (jsonb_typeof(metadata) = 'object'),
  constraint event_evidence_workspace_url_unique unique (workspace_id, event_id, url)
);

create table public.graph_nodes (
  id bigint generated always as identity primary key,
  workspace_id bigint not null references public.workspaces (id) on delete cascade,
  candidate_id bigint,
  identity_id bigint,
  node_type text not null,
  provider text not null,
  external_key text not null,
  label text not null,
  url text,
  properties jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint graph_nodes_workspace_id_id_unique unique (workspace_id, id),
  constraint graph_nodes_external_unique unique (workspace_id, provider, external_key),
  constraint graph_nodes_candidate_fk foreign key (workspace_id, candidate_id)
    references public.candidates (workspace_id, id) on delete set null (candidate_id),
  constraint graph_nodes_identity_fk foreign key (workspace_id, identity_id)
    references public.identities (workspace_id, id) on delete set null (identity_id),
  constraint graph_nodes_type_valid check (node_type in ('person', 'account', 'organization', 'project', 'paper', 'competition', 'topic')),
  constraint graph_nodes_provider_not_blank check (btrim(provider) <> '' and btrim(external_key) <> ''),
  constraint graph_nodes_label_not_blank check (btrim(label) <> ''),
  constraint graph_nodes_properties_object check (jsonb_typeof(properties) = 'object'),
  constraint graph_nodes_seen_time_order check (last_seen_at >= first_seen_at),
  constraint graph_nodes_single_binding check (candidate_id is null or identity_id is null)
);

create table public.graph_edges (
  id bigint generated always as identity primary key,
  workspace_id bigint not null references public.workspaces (id) on delete cascade,
  from_node_id bigint not null,
  to_node_id bigint not null,
  source_id bigint,
  relationship_type text not null,
  directed boolean not null default true,
  strength numeric(6,5) not null default 0.5,
  evidence_count integer not null default 1,
  first_observed_at timestamptz not null default now(),
  last_observed_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint graph_edges_workspace_id_id_unique unique (workspace_id, id),
  constraint graph_edges_from_fk foreign key (workspace_id, from_node_id)
    references public.graph_nodes (workspace_id, id) on delete cascade,
  constraint graph_edges_to_fk foreign key (workspace_id, to_node_id)
    references public.graph_nodes (workspace_id, id) on delete cascade,
  constraint graph_edges_source_fk foreign key (workspace_id, source_id)
    references public.sources (workspace_id, id) on delete set null (source_id),
  constraint graph_edges_no_self_loop check (from_node_id <> to_node_id),
  constraint graph_edges_relationship_not_blank check (btrim(relationship_type) <> ''),
  constraint graph_edges_strength_range check (strength between 0 and 1),
  constraint graph_edges_evidence_positive check (evidence_count > 0),
  constraint graph_edges_observed_time_order check (last_observed_at >= first_observed_at),
  constraint graph_edges_metadata_object check (jsonb_typeof(metadata) = 'object')
);

create table public.candidate_feedback (
  id bigint generated always as identity primary key,
  workspace_id bigint not null references public.workspaces (id) on delete cascade,
  candidate_id bigint not null,
  user_id uuid references auth.users (id) on delete set null,
  actor_key text not null default 'shared-dashboard',
  action text not null,
  reason_code text,
  note text,
  weight numeric(5,3) not null default 1,
  context jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint candidate_feedback_candidate_fk foreign key (workspace_id, candidate_id)
    references public.candidates (workspace_id, id) on delete cascade,
  constraint candidate_feedback_action_valid check (action in ('save', 'pass', 'watch', 'refer', 'contact', 'interview', 'accept', 'reject', 'correct_identity')),
  constraint candidate_feedback_actor_not_blank check (btrim(actor_key) <> ''),
  constraint candidate_feedback_weight_range check (weight between 0 and 10),
  constraint candidate_feedback_context_object check (jsonb_typeof(context) = 'object')
);

create table public.criterion_profiles (
  id bigint generated always as identity primary key,
  workspace_id bigint not null references public.workspaces (id) on delete cascade,
  parent_id bigint,
  name text not null,
  version integer not null,
  status text not null default 'draft',
  update_origin text not null default 'human',
  look_for_md text not null default '',
  avoid_md text not null default '',
  signal_weights jsonb not null default '{}'::jsonb,
  thresholds jsonb not null default '{}'::jsonb,
  digest_config jsonb not null default '{}'::jsonb,
  learning_rate numeric(6,5) not null default 0.01000,
  exploration_rate numeric(6,5) not null default 0.10000,
  training_sample_count integer not null default 0,
  change_summary text,
  change_set jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users (id) on delete set null,
  activated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint criterion_profiles_workspace_id_id_unique unique (workspace_id, id),
  constraint criterion_profiles_parent_fk foreign key (workspace_id, parent_id)
    references public.criterion_profiles (workspace_id, id) on delete set null (parent_id),
  constraint criterion_profiles_workspace_version_unique unique (workspace_id, version),
  constraint criterion_profiles_name_not_blank check (btrim(name) <> ''),
  constraint criterion_profiles_version_positive check (version > 0),
  constraint criterion_profiles_status_valid check (status in ('draft', 'active', 'retired')),
  constraint criterion_profiles_origin_valid check (update_origin in ('human', 'learned', 'hybrid', 'bootstrap')),
  constraint criterion_profiles_learning_rate_slow check (learning_rate between 0 and 0.05),
  constraint criterion_profiles_exploration_rate_range check (exploration_rate between 0 and 0.5),
  constraint criterion_profiles_sample_count_nonnegative check (training_sample_count >= 0),
  constraint criterion_profiles_signal_weights_object check (jsonb_typeof(signal_weights) = 'object'),
  constraint criterion_profiles_thresholds_object check (jsonb_typeof(thresholds) = 'object'),
  constraint criterion_profiles_digest_config_object check (jsonb_typeof(digest_config) = 'object'),
  constraint criterion_profiles_change_set_object check (jsonb_typeof(change_set) = 'object'),
  constraint criterion_profiles_activation_consistent check (
    (status = 'active' and activated_at is not null) or status <> 'active'
  )
);

create table public.digests (
  id bigint generated always as identity primary key,
  workspace_id bigint not null references public.workspaces (id) on delete cascade,
  dedupe_key text not null,
  criterion_profile_id bigint,
  status text not null default 'draft',
  period_start timestamptz not null,
  period_end timestamptz not null,
  subject text not null,
  preview_text text not null default '',
  candidate_count integer not null default 0,
  recipient_count integer not null default 0,
  generated_at timestamptz,
  scheduled_for timestamptz,
  sent_at timestamptz,
  provider_message_id text,
  delivery_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint digests_workspace_id_id_unique unique (workspace_id, id),
  constraint digests_workspace_dedupe_key_unique unique (workspace_id, dedupe_key),
  constraint digests_criterion_fk foreign key (workspace_id, criterion_profile_id)
    references public.criterion_profiles (workspace_id, id) on delete set null (criterion_profile_id),
  constraint digests_status_valid check (status in ('draft', 'ready', 'sending', 'sent', 'partial', 'failed', 'cancelled')),
  constraint digests_period_order check (period_end > period_start),
  constraint digests_dedupe_key_valid check (char_length(btrim(dedupe_key)) between 1 and 200),
  constraint digests_subject_not_blank check (btrim(subject) <> ''),
  constraint digests_counts_nonnegative check (candidate_count >= 0 and recipient_count >= 0),
  constraint digests_delivery_metadata_object check (jsonb_typeof(delivery_metadata) = 'object')
);

create table public.digest_items (
  workspace_id bigint not null references public.workspaces (id) on delete cascade,
  digest_id bigint not null,
  candidate_id bigint not null,
  rank integer not null,
  section text not null default 'top_discoveries',
  score_at_generation numeric(6,3) not null,
  headline_snapshot text not null,
  summary_snapshot_md text not null,
  why_now_snapshot_md text not null,
  evidence_links jsonb not null default '[]'::jsonb,
  payload_snapshot jsonb not null,
  created_at timestamptz not null default now(),
  primary key (digest_id, candidate_id),
  constraint digest_items_digest_fk foreign key (workspace_id, digest_id)
    references public.digests (workspace_id, id) on delete cascade,
  constraint digest_items_candidate_fk foreign key (workspace_id, candidate_id)
    references public.candidates (workspace_id, id) on delete cascade,
  constraint digest_items_rank_positive check (rank > 0),
  constraint digest_items_score_range check (score_at_generation between 0 and 100),
  constraint digest_items_section_valid check (section in ('top_discoveries', 'fast_movers', 'network_edge', 'wildcard', 'watchlist_update')),
  constraint digest_items_headline_not_blank check (btrim(headline_snapshot) <> ''),
  constraint digest_items_evidence_links_array check (jsonb_typeof(evidence_links) = 'array'),
  constraint digest_items_payload_snapshot_object check (jsonb_typeof(payload_snapshot) = 'object'),
  constraint digest_items_rank_unique unique (digest_id, rank)
);

-- Subscriber addresses are never granted to anon/authenticated. The app's shared-password
-- session gate must be verified before server code uses the service-role DAL.
create table public.digest_subscribers (
  id bigint generated always as identity primary key,
  workspace_id bigint not null references public.workspaces (id) on delete cascade,
  email text not null,
  display_name text,
  status text not null default 'active',
  delivery_status text not null default 'never_sent',
  delivery_metadata jsonb not null default '{}'::jsonb,
  last_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint digest_subscribers_workspace_id_id_unique unique (workspace_id, id),
  constraint digest_subscribers_email_format check (
    char_length(email) between 3 and 320
    and email = btrim(email)
    and email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  ),
  constraint digest_subscribers_status_valid check (status in ('active', 'paused')),
  constraint digest_subscribers_delivery_status_valid check (delivery_status in ('never_sent', 'delivered', 'bounced', 'complained', 'failed')),
  constraint digest_subscribers_delivery_metadata_object check (jsonb_typeof(delivery_metadata) = 'object')
);

-- Uniqueness, lookup, foreign-key, RLS, pagination, and queue indexes.
create index workspace_members_user_id_idx on public.workspace_members (user_id, workspace_id);
create index workspaces_created_by_idx on public.workspaces (created_by) where created_by is not null;
create index sources_due_idx on public.sources (workspace_id, next_run_at) where enabled and status = 'active';
create index sources_kind_idx on public.sources (workspace_id, kind) where enabled;
create index discovery_seeds_source_id_idx on public.discovery_seeds (source_id) where source_id is not null;
create index discovery_seeds_enabled_idx on public.discovery_seeds (workspace_id, provider, seed_type) where enabled;
create index ingestion_runs_source_id_idx on public.ingestion_runs (source_id) where source_id is not null;
create index ingestion_runs_parent_run_id_idx on public.ingestion_runs (parent_run_id) where parent_run_id is not null;
create index ingestion_runs_queue_idx on public.ingestion_runs (workspace_id, status, scheduled_for, id) where status in ('queued', 'running');
create index candidates_feed_idx on public.candidates (workspace_id, status, score desc, id desc) where status <> 'archived';
create index candidates_last_seen_idx on public.candidates (workspace_id, last_seen_at desc, id desc);
create index candidates_domains_idx on public.candidates using gin (domains);
create index candidates_search_vector_idx on public.candidates using gin (search_vector);
create index candidates_attributes_idx on public.candidates using gin (attributes jsonb_path_ops);
create index candidates_embedding_hnsw_idx on public.candidates using hnsw (embedding extensions.vector_cosine_ops) with (m = 16, ef_construction = 64);
create index identities_candidate_id_idx on public.identities (candidate_id) where candidate_id is not null;
create index identities_name_idx on public.identities (workspace_id, normalized_name, resolution_status);
create index identities_ambiguity_idx on public.identities (workspace_id, ambiguity_key) where resolution_status = 'ambiguous';
create unique index identities_provider_subject_unique on public.identities (workspace_id, provider, provider_subject_id) where provider_subject_id is not null;
create unique index identities_profile_url_unique on public.identities (workspace_id, provider, profile_url) where profile_url is not null;
create index identity_candidates_workspace_candidate_idx on public.identity_candidates (workspace_id, candidate_id, match_score desc);
create index identity_candidates_reviewed_by_idx on public.identity_candidates (reviewed_by) where reviewed_by is not null;
create unique index identity_candidates_one_accepted_idx on public.identity_candidates (identity_id) where decision = 'accepted';
create index events_candidate_feed_idx on public.events (workspace_id, candidate_id, discovered_at desc, id desc);
create index events_source_id_idx on public.events (source_id) where source_id is not null;
create index events_run_id_idx on public.events (run_id) where run_id is not null;
create index events_workspace_discovered_idx on public.events (workspace_id, discovered_at desc, id desc);
create unique index events_content_hash_unique on public.events (workspace_id, content_hash);
create unique index events_source_external_unique on public.events (workspace_id, source_id, external_id) where source_id is not null and external_id is not null;
create index events_embedding_hnsw_idx on public.events using hnsw (embedding extensions.vector_cosine_ops) with (m = 16, ef_construction = 64);
create index event_evidence_event_id_idx on public.event_evidence (event_id);
create index graph_nodes_candidate_id_idx on public.graph_nodes (candidate_id) where candidate_id is not null;
create index graph_nodes_identity_id_idx on public.graph_nodes (identity_id) where identity_id is not null;
create index graph_edges_from_idx on public.graph_edges (workspace_id, from_node_id, strength desc);
create index graph_edges_to_idx on public.graph_edges (workspace_id, to_node_id, strength desc);
create index graph_edges_source_id_idx on public.graph_edges (source_id) where source_id is not null;
create unique index graph_edges_natural_source_unique_idx
  on public.graph_edges (workspace_id, from_node_id, to_node_id, relationship_type, source_id)
  where source_id is not null;
create unique index graph_edges_natural_no_source_unique_idx
  on public.graph_edges (workspace_id, from_node_id, to_node_id, relationship_type)
  where source_id is null;
create index candidate_feedback_candidate_idx on public.candidate_feedback (workspace_id, candidate_id, created_at desc);
create index candidate_feedback_user_id_idx on public.candidate_feedback (user_id, workspace_id, created_at desc);
create index candidate_feedback_actor_idx on public.candidate_feedback (workspace_id, actor_key, created_at desc);
create index candidate_feedback_learning_idx on public.candidate_feedback (workspace_id, action, created_at desc);
create index criterion_profiles_parent_id_idx on public.criterion_profiles (parent_id) where parent_id is not null;
create index criterion_profiles_created_by_idx on public.criterion_profiles (created_by) where created_by is not null;
create unique index criterion_profiles_one_active_idx on public.criterion_profiles (workspace_id) where status = 'active';
create index digests_criterion_profile_id_idx on public.digests (criterion_profile_id) where criterion_profile_id is not null;
create index digests_workspace_period_idx on public.digests (workspace_id, period_end desc, id desc);
create index digest_items_candidate_id_idx on public.digest_items (candidate_id, digest_id);
create index digest_items_workspace_id_idx on public.digest_items (workspace_id);
create unique index digest_subscribers_email_unique on public.digest_subscribers (workspace_id, lower(email));
create index digest_subscribers_active_idx on public.digest_subscribers (workspace_id, id) where status = 'active';

create or replace function private.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function private.protect_workspace_creator()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.created_by is distinct from old.created_by then
    raise exception 'workspace creator is immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;

create or replace function private.bootstrap_workspace_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    return new;
  end if;

  if new.created_by is distinct from (select auth.uid()) then
    raise exception 'workspace creator must match the authenticated user' using errcode = '42501';
  end if;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (new.id, new.created_by, 'owner');
  return new;
end;
$$;

create or replace function private.is_workspace_member(target_workspace_id bigint)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and exists (
      select 1
      from public.workspace_members wm
      where wm.workspace_id = target_workspace_id
        and wm.user_id = (select auth.uid())
    );
$$;

create or replace function private.has_workspace_role(target_workspace_id bigint, allowed_roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and exists (
      select 1
      from public.workspace_members wm
      where wm.workspace_id = target_workspace_id
        and wm.user_id = (select auth.uid())
        and wm.role = any(allowed_roles)
    );
$$;

revoke all on function private.set_updated_at() from public, anon, authenticated;
revoke all on function private.protect_workspace_creator() from public, anon, authenticated;
revoke all on function private.bootstrap_workspace_membership() from public, anon, authenticated;
revoke all on function private.is_workspace_member(bigint) from public, anon;
revoke all on function private.has_workspace_role(bigint, text[]) from public, anon;
grant usage on schema private to authenticated, service_role;
grant execute on function private.text_array_to_search_text(text[]) to authenticated, service_role;
grant execute on function private.is_workspace_member(bigint) to authenticated;
grant execute on function private.has_workspace_role(bigint, text[]) to authenticated;

create trigger workspaces_set_updated_at before update on public.workspaces
for each row execute function private.set_updated_at();
create trigger workspaces_protect_creator before update on public.workspaces
for each row execute function private.protect_workspace_creator();
create trigger workspaces_bootstrap_membership after insert on public.workspaces
for each row execute function private.bootstrap_workspace_membership();

create trigger workspace_members_set_updated_at before update on public.workspace_members for each row execute function private.set_updated_at();
create trigger sources_set_updated_at before update on public.sources for each row execute function private.set_updated_at();
create trigger discovery_seeds_set_updated_at before update on public.discovery_seeds for each row execute function private.set_updated_at();
create trigger candidates_set_updated_at before update on public.candidates for each row execute function private.set_updated_at();
create trigger identities_set_updated_at before update on public.identities for each row execute function private.set_updated_at();
create trigger identity_candidates_set_updated_at before update on public.identity_candidates for each row execute function private.set_updated_at();
create trigger events_set_updated_at before update on public.events for each row execute function private.set_updated_at();
create trigger graph_nodes_set_updated_at before update on public.graph_nodes for each row execute function private.set_updated_at();
create trigger graph_edges_set_updated_at before update on public.graph_edges for each row execute function private.set_updated_at();
create trigger candidate_feedback_set_updated_at before update on public.candidate_feedback for each row execute function private.set_updated_at();
create trigger criterion_profiles_set_updated_at before update on public.criterion_profiles for each row execute function private.set_updated_at();
create trigger digests_set_updated_at before update on public.digests for each row execute function private.set_updated_at();
create trigger digest_subscribers_set_updated_at before update on public.digest_subscribers for each row execute function private.set_updated_at();

-- RPC: fast vector-only candidate retrieval. SECURITY INVOKER preserves RLS.
create or replace function public.match_candidates(
  p_workspace_id bigint,
  p_query_embedding extensions.vector(1536),
  p_match_threshold real default 0.55,
  p_match_count integer default 20,
  p_domains text[] default null,
  p_statuses text[] default null
)
returns table (
  id bigint,
  slug text,
  canonical_name text,
  headline text,
  location text,
  stage text,
  domains text[],
  score numeric,
  momentum numeric,
  confidence numeric,
  status text,
  summary_md text,
  why_now_md text,
  earlyness_md text,
  similarity real
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
    c.location,
    c.stage,
    c.domains,
    c.score,
    c.momentum,
    c.confidence,
    c.status,
    c.summary_md,
    c.why_now_md,
    c.earlyness_md,
    (1 - (c.embedding operator(extensions.<=>) p_query_embedding))::real as similarity
  from public.candidates c
  where c.workspace_id = p_workspace_id
    and c.embedding is not null
    and c.status <> 'archived'
    and (p_domains is null or c.domains && p_domains)
    and (p_statuses is null or c.status = any(p_statuses))
    and 1 - (c.embedding operator(extensions.<=>) p_query_embedding) >= greatest(0, least(1, p_match_threshold))
  order by c.embedding operator(extensions.<=>) p_query_embedding, c.id
  limit greatest(1, least(100, p_match_count));
$$;

-- RPC: weighted semantic + lexical retrieval. Pass NULL embedding for lexical-only search.
create or replace function public.hybrid_search_candidates(
  p_workspace_id bigint,
  p_query_text text,
  p_query_embedding extensions.vector(1536) default null,
  p_match_count integer default 20,
  p_semantic_weight real default 0.65,
  p_domains text[] default null
)
returns table (
  id bigint,
  slug text,
  canonical_name text,
  headline text,
  location text,
  stage text,
  domains text[],
  score numeric,
  momentum numeric,
  confidence numeric,
  status text,
  summary_md text,
  why_now_md text,
  earlyness_md text,
  semantic_similarity real,
  text_rank real,
  combined_score real
)
language sql
stable
security invoker
set search_path = ''
as $$
  with query_values as (
    select
      case
        when nullif(btrim(p_query_text), '') is null then null
        else websearch_to_tsquery('english', p_query_text)
      end as text_query,
      greatest(0, least(1, p_semantic_weight))::real as semantic_weight
  ), scored as (
    select
      c.*,
      case
        when p_query_embedding is null or c.embedding is null then 0::real
        else (1 - (c.embedding operator(extensions.<=>) p_query_embedding))::real
      end as semantic_similarity,
      case
        when q.text_query is null then 0::real
        else ts_rank_cd(c.search_vector, q.text_query, 32)::real
      end as text_rank,
      q.semantic_weight
    from public.candidates c
    cross join query_values q
    where c.workspace_id = p_workspace_id
      and c.status <> 'archived'
      and (p_domains is null or c.domains && p_domains)
      and (q.text_query is null or c.search_vector @@ q.text_query or p_query_embedding is not null)
  )
  select
    s.id,
    s.slug,
    s.canonical_name,
    s.headline,
    s.location,
    s.stage,
    s.domains,
    s.score,
    s.momentum,
    s.confidence,
    s.status,
    s.summary_md,
    s.why_now_md,
    s.earlyness_md,
    s.semantic_similarity,
    s.text_rank,
    (
      s.semantic_weight * s.semantic_similarity
      + (1 - s.semantic_weight) * least(1, s.text_rank * 4)
      + least(0.08, (s.score::real / 100) * 0.08)
    )::real as combined_score
  from scored s
  where s.semantic_similarity > 0 or s.text_rank > 0
  order by combined_score desc, s.score desc, s.id
  limit greatest(1, least(100, p_match_count));
$$;

create or replace function public.candidate_graph_neighbors(
  p_workspace_id bigint,
  p_candidate_id bigint,
  p_max_depth integer default 2,
  p_match_count integer default 100
)
returns table (
  node_id bigint,
  candidate_id bigint,
  label text,
  node_type text,
  depth integer,
  path_strength numeric,
  relationship_type text
)
language sql
stable
security invoker
set search_path = ''
as $$
  with recursive walk(node_id, depth, visited, path_strength, relationship_type) as (
    select n.id, 0, array[n.id], 1::numeric, 'self'::text
    from public.graph_nodes n
    where n.workspace_id = p_workspace_id and n.candidate_id = p_candidate_id

    union all

    select
      case when e.from_node_id = w.node_id then e.to_node_id else e.from_node_id end,
      w.depth + 1,
      w.visited || case when e.from_node_id = w.node_id then e.to_node_id else e.from_node_id end,
      least(w.path_strength, e.strength),
      e.relationship_type
    from walk w
    join public.graph_edges e
      on e.workspace_id = p_workspace_id
     and (e.from_node_id = w.node_id or e.to_node_id = w.node_id)
    where w.depth < greatest(1, least(4, p_max_depth))
      and not (
        case when e.from_node_id = w.node_id then e.to_node_id else e.from_node_id end
        = any(w.visited)
      )
  )
  select distinct on (n.id)
    n.id,
    n.candidate_id,
    n.label,
    n.node_type,
    w.depth,
    w.path_strength,
    w.relationship_type
  from walk w
  join public.graph_nodes n on n.workspace_id = p_workspace_id and n.id = w.node_id
  where w.depth > 0
  order by n.id, w.depth, w.path_strength desc
  limit greatest(1, least(500, p_match_count));
$$;

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
        and d.sent_at >= now() - make_interval(days => greatest(0, least(365, p_exclude_days)))
    )
  order by digest_rank_score desc, latest.discovered_at desc nulls last, c.id
  limit greatest(1, least(100, p_match_count));
$$;

-- Create the durable weekly record and its candidate snapshot in one transaction.
-- A concurrent caller for the same workspace/key receives the committed record
-- without replacing the original cohort.
create or replace function public.create_or_get_digest(
  p_workspace_id bigint,
  p_dedupe_key text,
  p_criterion_profile_id bigint,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_subject text,
  p_preview_text text,
  p_scheduled_for timestamptz,
  p_items jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_digest public.digests%rowtype;
  v_created boolean;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'digest items must be a JSON array' using errcode = '22023';
  end if;

  insert into public.digests (
    workspace_id,
    dedupe_key,
    criterion_profile_id,
    status,
    period_start,
    period_end,
    subject,
    preview_text,
    candidate_count,
    generated_at,
    scheduled_for
  )
  values (
    p_workspace_id,
    btrim(p_dedupe_key),
    p_criterion_profile_id,
    'ready',
    p_period_start,
    p_period_end,
    p_subject,
    coalesce(p_preview_text, ''),
    jsonb_array_length(p_items),
    now(),
    p_scheduled_for
  )
  on conflict on constraint digests_workspace_dedupe_key_unique do nothing
  returning * into v_digest;

  v_created := found;

  if v_created then
    insert into public.digest_items (
      workspace_id,
      digest_id,
      candidate_id,
      rank,
      section,
      score_at_generation,
      headline_snapshot,
      summary_snapshot_md,
      why_now_snapshot_md,
      evidence_links,
      payload_snapshot
    )
    select
      p_workspace_id,
      v_digest.id,
      item.candidate_id,
      item.rank,
      coalesce(item.section, 'top_discoveries'),
      item.score_at_generation,
      item.headline_snapshot,
      item.summary_snapshot_md,
      item.why_now_snapshot_md,
      coalesce(item.evidence_links, '[]'::jsonb),
      item.payload_snapshot
    from jsonb_to_recordset(p_items) as item (
      candidate_id bigint,
      rank integer,
      section text,
      score_at_generation numeric,
      headline_snapshot text,
      summary_snapshot_md text,
      why_now_snapshot_md text,
      evidence_links jsonb,
      payload_snapshot jsonb
    );
  else
    select d.*
    into strict v_digest
    from public.digests d
    where d.workspace_id = p_workspace_id
      and d.dedupe_key = btrim(p_dedupe_key);
  end if;

  return jsonb_build_object(
    'created', v_created,
    'digest', to_jsonb(v_digest)
  );
end;
$$;

-- Only one caller may transition a ready/retryable digest to sending. A lease
-- can be recovered after a bounded interval if the prior invocation died, but
-- failed/uncertain attempts stop being retryable before provider keys expire.
create or replace function public.claim_digest_delivery(
  p_workspace_id bigint,
  p_digest_id bigint,
  p_stale_after_minutes integer default 15,
  p_retry_window_minutes integer default 1380
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_digest public.digests%rowtype;
begin
  update public.digests d
  set status = 'sending'
  where d.workspace_id = p_workspace_id
    and d.id = p_digest_id
    and (
      d.status = 'ready'
      or (
        d.status = 'failed'
        and d.updated_at >= now() - make_interval(
          mins => greatest(60, least(1380, coalesce(p_retry_window_minutes, 1380)))
        )
      )
      or (
        d.status = 'sending'
        and d.updated_at <= now() - make_interval(
          mins => greatest(5, least(60, coalesce(p_stale_after_minutes, 15)))
        )
        and d.updated_at >= now() - make_interval(
          mins => greatest(60, least(1380, coalesce(p_retry_window_minutes, 1380)))
        )
      )
    )
  returning d.* into v_digest;

  if found then
    return jsonb_build_object('claimed', true, 'digest', to_jsonb(v_digest));
  end if;

  select d.*
  into v_digest
  from public.digests d
  where d.workspace_id = p_workspace_id
    and d.id = p_digest_id;

  if not found then
    return null;
  end if;

  return jsonb_build_object('claimed', false, 'digest', to_jsonb(v_digest));
end;
$$;

create or replace function public.workspace_dashboard_metrics(p_workspace_id bigint)
returns table (
  total_candidates bigint,
  new_this_week bigint,
  high_signal_candidates bigint,
  unresolved_identities bigint,
  active_sources bigint,
  queued_runs bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    (select count(*) from public.candidates c where c.workspace_id = p_workspace_id and c.status <> 'archived'),
    (select count(*) from public.candidates c where c.workspace_id = p_workspace_id and c.first_seen_at >= now() - interval '7 days'),
    (select count(*) from public.candidates c where c.workspace_id = p_workspace_id and c.status <> 'archived' and c.score >= 80),
    (select count(*) from public.identities i where i.workspace_id = p_workspace_id and i.resolution_status in ('unresolved', 'ambiguous')),
    (select count(*) from public.sources s where s.workspace_id = p_workspace_id and s.enabled and s.status = 'active'),
    (select count(*) from public.ingestion_runs r where r.workspace_id = p_workspace_id and r.status in ('queued', 'running'));
$$;

-- Service-only queue claim. Row locks prevent overlapping cron invocations from
-- leasing the same source. next_run_at acts as the lease expiry.
create or replace function public.claim_due_sources(
  p_workspace_id bigint,
  p_match_count integer default 10,
  p_lease_minutes integer default 15
)
returns table (
  id bigint,
  workspace_id bigint,
  connector_key text,
  name text,
  kind text,
  base_url text,
  trust_weight numeric,
  max_requests_per_run integer,
  discovery_config jsonb
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  return query
  with due as (
    select s.id
    from public.sources s
    where s.workspace_id = p_workspace_id
      and s.enabled
      and s.status = 'active'
      and s.next_run_at <= now()
    order by s.next_run_at, s.id
    for update skip locked
    limit greatest(1, least(100, p_match_count))
  ), leased as (
    update public.sources s
    set
      last_attempt_at = now(),
      next_run_at = now() + make_interval(mins => greatest(1, least(120, p_lease_minutes)))
    from due
    where s.id = due.id
    returning s.*
  )
  select
    s.id,
    s.workspace_id,
    s.connector_key,
    s.name,
    s.kind,
    s.base_url,
    s.trust_weight,
    s.max_requests_per_run,
    s.discovery_config
  from leased s
  order by s.id;
end;
$$;

create or replace function public.resolve_identity_candidate(
  p_workspace_id bigint,
  p_identity_id bigint,
  p_candidate_id bigint,
  p_decision text,
  p_reviewer uuid default null
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  if p_decision not in ('accepted', 'rejected') then
    raise exception 'decision must be accepted or rejected' using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.identity_candidates ic
    where ic.workspace_id = p_workspace_id
      and ic.identity_id = p_identity_id
      and ic.candidate_id = p_candidate_id
  ) then
    raise exception 'identity candidate hypothesis not found' using errcode = 'P0002';
  end if;

  if p_decision = 'accepted' then
    update public.identity_candidates ic
    set decision = 'rejected', reviewed_by = p_reviewer, reviewed_at = now()
    where ic.workspace_id = p_workspace_id
      and ic.identity_id = p_identity_id
      and ic.decision = 'accepted'
      and ic.candidate_id <> p_candidate_id;
  end if;

  update public.identity_candidates ic
  set decision = p_decision, reviewed_by = p_reviewer, reviewed_at = now()
  where ic.workspace_id = p_workspace_id
    and ic.identity_id = p_identity_id
    and ic.candidate_id = p_candidate_id;

  if p_decision = 'accepted' then
    update public.identities i
    set candidate_id = p_candidate_id, resolution_status = 'resolved', match_confidence = 1
    where i.workspace_id = p_workspace_id and i.id = p_identity_id;
  elsif not exists (
    select 1 from public.identity_candidates ic
    where ic.workspace_id = p_workspace_id
      and ic.identity_id = p_identity_id
      and ic.decision = 'accepted'
  ) then
    update public.identities i
    set
      candidate_id = null,
      resolution_status = case
        when (select count(*) from public.identity_candidates ic
              where ic.workspace_id = p_workspace_id
                and ic.identity_id = p_identity_id
                and ic.decision = 'proposed') > 1
        then 'ambiguous'
        else 'unresolved'
      end
    where i.workspace_id = p_workspace_id and i.id = p_identity_id;
  end if;
end;
$$;

create or replace function public.activate_criterion_profile(
  p_workspace_id bigint,
  p_profile_id bigint
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.criterion_profiles cp
    where cp.workspace_id = p_workspace_id and cp.id = p_profile_id
  ) then
    raise exception 'criterion profile not found' using errcode = 'P0002';
  end if;

  update public.criterion_profiles cp
  set status = 'retired'
  where cp.workspace_id = p_workspace_id
    and cp.status = 'active'
    and cp.id <> p_profile_id;

  update public.criterion_profiles cp
  set status = 'active', activated_at = now()
  where cp.workspace_id = p_workspace_id and cp.id = p_profile_id;
end;
$$;

revoke all on function public.match_candidates(bigint, extensions.vector, real, integer, text[], text[]) from public, anon;
revoke all on function public.hybrid_search_candidates(bigint, text, extensions.vector, integer, real, text[]) from public, anon;
revoke all on function public.candidate_graph_neighbors(bigint, bigint, integer, integer) from public, anon;
revoke all on function public.rank_candidates_for_digest(bigint, numeric, integer, integer) from public, anon;
revoke all on function public.create_or_get_digest(bigint, text, bigint, timestamptz, timestamptz, text, text, timestamptz, jsonb) from public, anon, authenticated;
revoke all on function public.claim_digest_delivery(bigint, bigint, integer, integer) from public, anon, authenticated;
revoke all on function public.workspace_dashboard_metrics(bigint) from public, anon;
revoke all on function public.claim_due_sources(bigint, integer, integer) from public, anon, authenticated;
revoke all on function public.resolve_identity_candidate(bigint, bigint, bigint, text, uuid) from public, anon, authenticated;
revoke all on function public.activate_criterion_profile(bigint, bigint) from public, anon, authenticated;
grant execute on function public.match_candidates(bigint, extensions.vector, real, integer, text[], text[]) to authenticated, service_role;
grant execute on function public.hybrid_search_candidates(bigint, text, extensions.vector, integer, real, text[]) to authenticated, service_role;
grant execute on function public.candidate_graph_neighbors(bigint, bigint, integer, integer) to authenticated, service_role;
grant execute on function public.rank_candidates_for_digest(bigint, numeric, integer, integer) to authenticated, service_role;
grant execute on function public.create_or_get_digest(bigint, text, bigint, timestamptz, timestamptz, text, text, timestamptz, jsonb) to service_role;
grant execute on function public.claim_digest_delivery(bigint, bigint, integer, integer) to service_role;
grant execute on function public.workspace_dashboard_metrics(bigint) to authenticated, service_role;
grant execute on function public.claim_due_sources(bigint, integer, integer) to service_role;
grant execute on function public.resolve_identity_candidate(bigint, bigint, bigint, text, uuid) to service_role;
grant execute on function public.activate_criterion_profile(bigint, bigint) to service_role;

-- Data API exposure is explicit. RLS below remains the row-level authorization boundary.
-- Keep the grants scoped to this migration's objects so applying it to a non-empty
-- project cannot change access to unrelated public tables or sequences.
revoke all on public.workspaces, public.workspace_members, public.sources, public.discovery_seeds,
  public.ingestion_runs, public.candidates, public.identities, public.identity_candidates,
  public.events, public.event_evidence, public.graph_nodes, public.graph_edges,
  public.candidate_feedback, public.criterion_profiles, public.digests, public.digest_items,
  public.digest_subscribers
from anon, authenticated;
grant select on public.workspaces, public.workspace_members, public.sources, public.discovery_seeds,
  public.ingestion_runs, public.candidates, public.identities, public.identity_candidates,
  public.events, public.event_evidence, public.graph_nodes, public.graph_edges,
  public.candidate_feedback, public.criterion_profiles, public.digests, public.digest_items
to authenticated;
grant insert, update, delete on public.workspaces to authenticated;
grant insert, update, delete on public.workspace_members, public.sources, public.discovery_seeds,
  public.candidate_feedback, public.criterion_profiles
to authenticated;
grant update on public.candidates to authenticated;
grant all on public.workspaces, public.workspace_members, public.sources, public.discovery_seeds,
  public.ingestion_runs, public.candidates, public.identities, public.identity_candidates,
  public.events, public.event_evidence, public.graph_nodes, public.graph_edges,
  public.candidate_feedback, public.criterion_profiles, public.digests, public.digest_items,
  public.digest_subscribers
to service_role;
grant usage, select on sequence public.workspaces_id_seq, public.sources_id_seq,
  public.discovery_seeds_id_seq, public.ingestion_runs_id_seq, public.candidates_id_seq,
  public.identities_id_seq, public.events_id_seq, public.event_evidence_id_seq,
  public.graph_nodes_id_seq, public.graph_edges_id_seq, public.candidate_feedback_id_seq,
  public.criterion_profiles_id_seq, public.digests_id_seq, public.digest_subscribers_id_seq
to service_role;
grant usage, select on sequence public.workspaces_id_seq to authenticated;
grant usage, select on sequence public.sources_id_seq, public.discovery_seeds_id_seq,
  public.candidate_feedback_id_seq, public.criterion_profiles_id_seq
to authenticated;

alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.sources enable row level security;
alter table public.discovery_seeds enable row level security;
alter table public.ingestion_runs enable row level security;
alter table public.candidates enable row level security;
alter table public.identities enable row level security;
alter table public.identity_candidates enable row level security;
alter table public.events enable row level security;
alter table public.event_evidence enable row level security;
alter table public.graph_nodes enable row level security;
alter table public.graph_edges enable row level security;
alter table public.candidate_feedback enable row level security;
alter table public.criterion_profiles enable row level security;
alter table public.digests enable row level security;
alter table public.digest_items enable row level security;
alter table public.digest_subscribers enable row level security;

alter table public.workspaces force row level security;
alter table public.workspace_members force row level security;
alter table public.sources force row level security;
alter table public.discovery_seeds force row level security;
alter table public.ingestion_runs force row level security;
alter table public.candidates force row level security;
alter table public.identities force row level security;
alter table public.identity_candidates force row level security;
alter table public.events force row level security;
alter table public.event_evidence force row level security;
alter table public.graph_nodes force row level security;
alter table public.graph_edges force row level security;
alter table public.candidate_feedback force row level security;
alter table public.criterion_profiles force row level security;
alter table public.digests force row level security;
alter table public.digest_items force row level security;
alter table public.digest_subscribers force row level security;

create policy workspaces_select_member on public.workspaces for select to authenticated
using ((select private.is_workspace_member(id)));
create policy workspaces_insert_creator on public.workspaces for insert to authenticated
with check ((select auth.uid()) is not null and (select auth.uid()) = created_by);
create policy workspaces_update_owner on public.workspaces for update to authenticated
using ((select private.has_workspace_role(id, array['owner']::text[])))
with check ((select private.has_workspace_role(id, array['owner']::text[])));
create policy workspaces_delete_owner on public.workspaces for delete to authenticated
using ((select private.has_workspace_role(id, array['owner']::text[])));

create policy workspace_members_select_member on public.workspace_members for select to authenticated
using ((select private.is_workspace_member(workspace_id)));
create policy workspace_members_insert_owner on public.workspace_members for insert to authenticated
with check ((select private.has_workspace_role(workspace_id, array['owner']::text[])));
create policy workspace_members_update_owner on public.workspace_members for update to authenticated
using ((select private.has_workspace_role(workspace_id, array['owner']::text[])))
with check ((select private.has_workspace_role(workspace_id, array['owner']::text[])));
create policy workspace_members_delete_owner on public.workspace_members for delete to authenticated
using ((select private.has_workspace_role(workspace_id, array['owner']::text[])));

create policy sources_select_member on public.sources for select to authenticated
using ((select private.is_workspace_member(workspace_id)));
create policy sources_insert_admin on public.sources for insert to authenticated
with check ((select private.has_workspace_role(workspace_id, array['owner', 'admin']::text[])));
create policy sources_update_admin on public.sources for update to authenticated
using ((select private.has_workspace_role(workspace_id, array['owner', 'admin']::text[])))
with check ((select private.has_workspace_role(workspace_id, array['owner', 'admin']::text[])));
create policy sources_delete_admin on public.sources for delete to authenticated
using ((select private.has_workspace_role(workspace_id, array['owner', 'admin']::text[])));

create policy discovery_seeds_select_member on public.discovery_seeds for select to authenticated
using ((select private.is_workspace_member(workspace_id)));
create policy discovery_seeds_insert_admin on public.discovery_seeds for insert to authenticated
with check ((select private.has_workspace_role(workspace_id, array['owner', 'admin']::text[])));
create policy discovery_seeds_update_admin on public.discovery_seeds for update to authenticated
using ((select private.has_workspace_role(workspace_id, array['owner', 'admin']::text[])))
with check ((select private.has_workspace_role(workspace_id, array['owner', 'admin']::text[])));
create policy discovery_seeds_delete_admin on public.discovery_seeds for delete to authenticated
using ((select private.has_workspace_role(workspace_id, array['owner', 'admin']::text[])));

create policy ingestion_runs_select_member on public.ingestion_runs for select to authenticated
using ((select private.is_workspace_member(workspace_id)));

create policy candidates_select_member on public.candidates for select to authenticated
using ((select private.is_workspace_member(workspace_id)));
create policy candidates_update_scout on public.candidates for update to authenticated
using ((select private.has_workspace_role(workspace_id, array['owner', 'admin', 'scout']::text[])))
with check ((select private.has_workspace_role(workspace_id, array['owner', 'admin', 'scout']::text[])));

create policy identities_select_member on public.identities for select to authenticated
using ((select private.is_workspace_member(workspace_id)));
create policy identity_candidates_select_member on public.identity_candidates for select to authenticated
using ((select private.is_workspace_member(workspace_id)));
create policy events_select_member on public.events for select to authenticated
using ((select private.is_workspace_member(workspace_id)));
create policy event_evidence_select_member on public.event_evidence for select to authenticated
using ((select private.is_workspace_member(workspace_id)));
create policy graph_nodes_select_member on public.graph_nodes for select to authenticated
using ((select private.is_workspace_member(workspace_id)));
create policy graph_edges_select_member on public.graph_edges for select to authenticated
using ((select private.is_workspace_member(workspace_id)));

create policy candidate_feedback_select_member on public.candidate_feedback for select to authenticated
using ((select private.is_workspace_member(workspace_id)));
create policy candidate_feedback_insert_self on public.candidate_feedback for insert to authenticated
with check (
  (select auth.uid()) = user_id
  and (select private.has_workspace_role(workspace_id, array['owner', 'admin', 'scout']::text[]))
);
create policy candidate_feedback_update_self on public.candidate_feedback for update to authenticated
using ((select auth.uid()) = user_id and (select private.is_workspace_member(workspace_id)))
with check ((select auth.uid()) = user_id and (select private.is_workspace_member(workspace_id)));
create policy candidate_feedback_delete_self on public.candidate_feedback for delete to authenticated
using ((select auth.uid()) = user_id and (select private.is_workspace_member(workspace_id)));

create policy criterion_profiles_select_member on public.criterion_profiles for select to authenticated
using ((select private.is_workspace_member(workspace_id)));
create policy criterion_profiles_insert_admin on public.criterion_profiles for insert to authenticated
with check ((select private.has_workspace_role(workspace_id, array['owner', 'admin']::text[])));
create policy criterion_profiles_update_admin on public.criterion_profiles for update to authenticated
using ((select private.has_workspace_role(workspace_id, array['owner', 'admin']::text[])))
with check ((select private.has_workspace_role(workspace_id, array['owner', 'admin']::text[])));
create policy criterion_profiles_delete_admin on public.criterion_profiles for delete to authenticated
using ((select private.has_workspace_role(workspace_id, array['owner', 'admin']::text[])));

create policy digests_select_member on public.digests for select to authenticated
using ((select private.is_workspace_member(workspace_id)));
create policy digest_items_select_member on public.digest_items for select to authenticated
using ((select private.is_workspace_member(workspace_id)));

-- digest_subscribers intentionally has no end-user policy and no end-user table grant.
-- Only service_role can access subscriber addresses after application session verification.
