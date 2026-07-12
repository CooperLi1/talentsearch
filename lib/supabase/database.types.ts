export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

type Relation = {
  foreignKeyName: string;
  columns: string[];
  isOneToOne?: boolean;
  referencedRelation: string;
  referencedColumns: string[];
};

type Table<Row extends Record<string, unknown>, Insert extends Record<string, unknown>> = {
  Row: Row;
  Insert: Insert;
  Update: Partial<Insert>;
  Relationships: Relation[];
};

type LooseRow = Record<string, Json | string[] | null>;
type LooseInsert = Record<string, Json | string[] | undefined>;

export interface CandidateRow extends Record<string, unknown> {
  id: number;
  workspace_id: number;
  slug: string;
  canonical_name: string;
  sort_name: string;
  headline: string | null;
  location: string | null;
  stage: string | null;
  school: string | null;
  avatar_url: string | null;
  domains: string[];
  status: string;
  score: number;
  momentum: number;
  confidence: number;
  source_count: number;
  summary_md: string;
  why_now_md: string;
  earlyness_md: string;
  score_components: Json;
  attributes: Json;
  search_text: string;
  search_vector: unknown;
  embedding: string | null;
  embedding_model: string | null;
  embedding_updated_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
}

export interface CandidateInsert extends Record<string, unknown> {
  workspace_id: number;
  slug: string;
  canonical_name: string;
  sort_name: string;
  headline?: string | null;
  location?: string | null;
  stage?: string | null;
  school?: string | null;
  avatar_url?: string | null;
  domains?: string[];
  status?: string;
  score?: number;
  momentum?: number;
  confidence?: number;
  source_count?: number;
  summary_md?: string;
  why_now_md?: string;
  earlyness_md?: string;
  score_components?: Json;
  attributes?: Json;
  search_text?: string;
  embedding?: string | number[] | null;
  embedding_model?: string | null;
  embedding_updated_at?: string | null;
  first_seen_at?: string;
  last_seen_at?: string;
}

export interface EventRow extends Record<string, unknown> {
  id: number;
  workspace_id: number;
  candidate_id: number;
  source_id: number | null;
  run_id: number | null;
  event_type: string;
  title: string;
  summary_md: string;
  why_it_matters_md: string;
  occurred_at: string | null;
  discovered_at: string;
  source_url: string;
  source_label: string;
  external_id: string | null;
  content_hash: string;
  evidence_excerpt: string | null;
  confidence: number;
  novelty_score: number;
  significance_score: number;
  raw_payload: Json;
  llm_model: string | null;
  prompt_version: string | null;
  embedding: string | null;
  embedding_model: string | null;
  embedding_updated_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SourceRow extends Record<string, unknown> {
  id: number;
  workspace_id: number;
  connector_key: string;
  name: string;
  kind: string;
  base_url: string | null;
  status: string;
  enabled: boolean;
  trust_weight: number;
  crawl_interval_minutes: number;
  max_requests_per_run: number;
  discovery_config: Json;
  health_metadata: Json;
  last_attempt_at: string | null;
  last_success_at: string | null;
  next_run_at: string;
  created_at: string;
  updated_at: string;
}

export interface DigestSubscriberRow extends Record<string, unknown> {
  id: number;
  workspace_id: number;
  email: string;
  display_name: string | null;
  status: string;
  delivery_status: string;
  delivery_metadata: Json;
  last_sent_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DigestRow extends Record<string, unknown> {
  id: number;
  workspace_id: number;
  dedupe_key: string;
  criterion_profile_id: number | null;
  status: string;
  period_start: string;
  period_end: string;
  subject: string;
  preview_text: string;
  candidate_count: number;
  recipient_count: number;
  generated_at: string | null;
  scheduled_for: string | null;
  sent_at: string | null;
  provider_message_id: string | null;
  delivery_metadata: Json;
  created_at: string;
  updated_at: string;
}

export interface DigestInsert extends Record<string, unknown> {
  workspace_id: number;
  dedupe_key: string;
  period_start: string;
  period_end: string;
  subject: string;
  criterion_profile_id?: number | null;
  status?: string;
  preview_text?: string;
  candidate_count?: number;
  recipient_count?: number;
  generated_at?: string | null;
  scheduled_for?: string | null;
  sent_at?: string | null;
  provider_message_id?: string | null;
  delivery_metadata?: Json;
}

export interface DigestItemRow extends Record<string, unknown> {
  workspace_id: number;
  digest_id: number;
  candidate_id: number;
  rank: number;
  section: string;
  score_at_generation: number;
  headline_snapshot: string;
  summary_snapshot_md: string;
  why_now_snapshot_md: string;
  evidence_links: Json;
  payload_snapshot: Json;
  created_at: string;
}

export interface DigestItemInsert extends Record<string, unknown> {
  workspace_id: number;
  digest_id: number;
  candidate_id: number;
  rank: number;
  score_at_generation: number;
  headline_snapshot: string;
  summary_snapshot_md: string;
  why_now_snapshot_md: string;
  payload_snapshot: Json;
  section?: string;
  evidence_links?: Json;
}

export interface CriterionProfileRow extends Record<string, unknown> {
  id: number;
  workspace_id: number;
  parent_id: number | null;
  name: string;
  version: number;
  status: string;
  update_origin: string;
  look_for_md: string;
  avoid_md: string;
  signal_weights: Json;
  thresholds: Json;
  digest_config: Json;
  learning_rate: number;
  exploration_rate: number;
  training_sample_count: number;
  change_summary: string | null;
  change_set: Json;
  created_by: string | null;
  activated_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface IngestionRunRow extends Record<string, unknown> {
  id: number;
  workspace_id: number;
  source_id: number | null;
  parent_run_id: number | null;
  run_kind: string;
  status: string;
  scheduled_for: string;
  started_at: string | null;
  finished_at: string | null;
  heartbeat_at: string | null;
  attempt: number;
  discovered_count: number;
  enriched_count: number;
  event_count: number;
  error_count: number;
  cursor: Json;
  metrics: Json;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
}

export type Database = {
  public: {
    Tables: {
      workspaces: Table<LooseRow, LooseInsert>;
      workspace_members: Table<LooseRow, LooseInsert>;
      sources: Table<SourceRow, Partial<SourceRow> & Pick<SourceRow, "workspace_id" | "connector_key" | "name" | "kind">>;
      discovery_seeds: Table<LooseRow, LooseInsert>;
      ingestion_runs: Table<IngestionRunRow, Partial<IngestionRunRow> & Pick<IngestionRunRow, "workspace_id">>;
      candidates: Table<CandidateRow, CandidateInsert>;
      identities: Table<LooseRow, LooseInsert>;
      identity_candidates: Table<LooseRow, LooseInsert>;
      events: Table<EventRow, Partial<EventRow> & Pick<EventRow, "workspace_id" | "candidate_id" | "event_type" | "title" | "source_url" | "source_label" | "content_hash">>;
      event_evidence: Table<LooseRow, LooseInsert>;
      graph_nodes: Table<LooseRow, LooseInsert>;
      graph_edges: Table<LooseRow, LooseInsert>;
      candidate_feedback: Table<LooseRow, LooseInsert>;
      criterion_profiles: Table<CriterionProfileRow, Partial<CriterionProfileRow> & Pick<CriterionProfileRow, "workspace_id" | "name" | "version">>;
      digests: Table<DigestRow, DigestInsert>;
      digest_items: Table<DigestItemRow, DigestItemInsert>;
      digest_subscribers: Table<DigestSubscriberRow, Partial<DigestSubscriberRow> & Pick<DigestSubscriberRow, "workspace_id" | "email">>;
    };
    Views: Record<string, never>;
    Functions: {
      match_candidates: {
        Args: {
          p_workspace_id: number;
          p_query_embedding: string | number[];
          p_match_threshold?: number;
          p_match_count?: number;
          p_domains?: string[] | null;
          p_statuses?: string[] | null;
        };
        Returns: Array<Record<string, Json | string[]>>;
      };
      hybrid_search_candidates: {
        Args: {
          p_workspace_id: number;
          p_query_text: string;
          p_query_embedding?: string | number[] | null;
          p_match_count?: number;
          p_semantic_weight?: number;
          p_domains?: string[] | null;
        };
        Returns: Array<Record<string, Json | string[]>>;
      };
      candidate_graph_neighbors: {
        Args: {
          p_workspace_id: number;
          p_candidate_id: number;
          p_max_depth?: number;
          p_match_count?: number;
        };
        Returns: Array<Record<string, Json>>;
      };
      rank_candidates_for_digest: {
        Args: {
          p_workspace_id: number;
          p_min_score?: number;
          p_match_count?: number;
          p_exclude_days?: number;
        };
        Returns: Array<Record<string, Json>>;
      };
      create_or_get_digest: {
        Args: {
          p_workspace_id: number;
          p_dedupe_key: string;
          p_criterion_profile_id: number | null;
          p_period_start: string;
          p_period_end: string;
          p_subject: string;
          p_preview_text: string;
          p_scheduled_for: string | null;
          p_items: Json;
        };
        Returns: Json;
      };
      claim_digest_delivery: {
        Args: {
          p_workspace_id: number;
          p_digest_id: number;
          p_stale_after_minutes?: number;
          p_retry_window_minutes?: number;
        };
        Returns: Json;
      };
      workspace_dashboard_metrics: {
        Args: { p_workspace_id: number };
        Returns: Array<Record<string, Json>>;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
