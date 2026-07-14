import type {
  CandidateContactRoute,
  CandidateStatus,
  CriterionSignal,
  DeliveryStatus,
  DiscoverySource,
  EditableSourceConfiguration,
  EvidenceLink,
  SubscriberStatus,
} from "@/lib/domain/types";
import type { Json } from "@/lib/supabase/database.types";

export interface SourceRecord {
  id: string;
  workspaceId: string;
  key: string;
  name: string;
  kind: string;
  baseUrl: string | null;
  trustWeight: number;
  maxRequestsPerRun: number;
  config: Json;
  nextRunAt?: string;
}

export type SourceSetupRequirement =
  | "openalex_connection"
  | "hugging_face_queries"
  | "x_connection"
  | "x_data_use_approval"
  | "x_queries"
  | "web_search_connection"
  | "linkedin_profiles"
  | "feed_urls"
  | "structured_pages"
  | "unsupported_source";

export type UpdateSourceEnabledResult =
  | { ok: true; source: DiscoverySource }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "invalid_configuration"; message: string }
  | {
      ok: false;
      reason: "setup_required";
      requirement: SourceSetupRequirement;
    };

export type UpdateSourceConfigurationResult = UpdateSourceEnabledResult;

export type SourceConfigurationUpdate = EditableSourceConfiguration;

export interface CreateIngestionRunInput {
  workspaceId: string | number;
  sourceId?: string | number | null;
  parentRunId?: string | number | null;
  kind?: "scheduled" | "manual" | "enrichment" | "graph_expansion" | "backfill" | "retry";
  scheduledFor?: string;
  cursor?: Json;
}

export interface IngestionRunRecord {
  id: string;
  workspaceId: string;
  sourceId: string | null;
  status: "queued" | "running" | "succeeded" | "partial" | "failed" | "cancelled";
  kind: string;
  scheduledFor: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface UpdateIngestionRunInput {
  status?: IngestionRunRecord["status"];
  startedAt?: string | null;
  finishedAt?: string | null;
  heartbeatAt?: string | null;
  discoveredCount?: number;
  enrichedCount?: number;
  eventCount?: number;
  errorCount?: number;
  cursor?: Json;
  metrics?: Json;
  errorCode?: string | null;
  errorMessage?: string | null;
}

export interface UpsertCandidateInput {
  workspaceId: string | number;
  slug: string;
  name: string;
  sortName?: string;
  headline?: string | null;
  location?: string | null;
  stage?: string | null;
  school?: string | null;
  avatarUrl?: string | null;
  domains?: string[];
  status?: CandidateStatus;
  score?: number;
  momentum?: number;
  confidence?: number;
  summaryMarkdown?: string;
  whyNowMarkdown?: string;
  earlynessMarkdown?: string;
  attributes?: Json;
  searchText?: string;
  lastSeenAt?: string;
}

export interface MergeCandidateObservationInput {
  workspaceId: string | number;
  candidateId: string | number;
  displayName: string;
  headline?: string | null;
  biography?: string | null;
  location?: string | null;
  affiliations?: string[];
  alternateNames?: Array<{
    name: string;
    sourceUrl: string;
    confidence: number;
    proof: string;
  }>;
  avatarUrl?: string | null;
  websiteUrl?: string | null;
  sourceUrl: string;
  provider: string;
  providerSubjectId: string;
  providerHandle?: string | null;
  providerProfileUrl?: string | null;
  providerVerified: boolean;
  contactRoutes?: CandidateContactRoute[];
  seenAt?: string;
}

export interface MergeCandidateObservationResult {
  candidateUpdated: boolean;
  nameUpdated: boolean;
  websiteStored: boolean;
  websiteConflictCandidateId?: string;
}

export interface IdentityObservationInput {
  workspaceId: string | number;
  provider: string;
  providerSubjectId?: string | null;
  handle?: string | null;
  profileUrl?: string | null;
  displayName: string;
  normalizedName: string;
  candidateId?: string | number | null;
  ambiguityKey?: string | null;
  confidence?: number;
  matchMethod?: string | null;
  distinguishingFacts?: Json;
  evidence?: Json[];
  seenAt?: string;
}

export interface IdentityCandidateMatch {
  candidateId: string;
  identityId?: string;
  name: string;
  slug: string;
  score: number;
  signals: Json;
  exactProviderMatch: boolean;
}

export interface IdentityResolutionResult {
  identityId: string;
  status: "unresolved" | "ambiguous" | "resolved" | "rejected";
  candidateId: string | null;
  matches: IdentityCandidateMatch[];
}

export interface AddIdentityCandidateHypothesisInput {
  workspaceId: string | number;
  identityId: string | number;
  candidateId: string | number;
  score: number;
  signals?: Json;
}

export interface ReviewIdentityCandidateInput {
  workspaceId: string | number;
  identityId: string | number;
  candidateId: string | number;
  decision: "accepted" | "rejected";
  reviewerUserId?: string | null;
}

export interface InsertCandidateEventInput {
  workspaceId: string | number;
  candidateId: string | number;
  sourceId?: string | number | null;
  runId?: string | number | null;
  eventType: string;
  title: string;
  summaryMarkdown?: string;
  whyItMattersMarkdown?: string;
  occurredAt?: string | null;
  discoveredAt?: string;
  sourceUrl: string;
  sourceLabel: string;
  externalId?: string | null;
  contentHash: string;
  evidenceExcerpt?: string | null;
  confidence?: number;
  novelty?: number;
  significance?: number;
  rawPayload?: Json;
  llmModel?: string | null;
  promptVersion?: string | null;
  embedding?: number[] | null;
  embeddingModel?: string | null;
  evidenceLinks?: EvidenceLink[];
}

export interface UpsertGraphNodeInput {
  workspaceId: string | number;
  candidateId?: string | number | null;
  identityId?: string | number | null;
  nodeType: "person" | "account" | "organization" | "project" | "paper" | "competition" | "topic";
  provider: string;
  externalKey: string;
  label: string;
  url?: string | null;
  properties?: Json;
  seenAt?: string;
}

export interface UpsertGraphEdgeInput {
  workspaceId: string | number;
  fromNodeId: string | number;
  toNodeId: string | number;
  sourceId?: string | number | null;
  relationshipType: string;
  directed?: boolean;
  strength?: number;
  evidenceCount?: number;
  observedAt?: string;
  metadata?: Json;
}

export interface UpdateCandidateIntelligenceInput {
  workspaceId: string | number;
  candidateId: string | number;
  score?: number;
  momentum?: number;
  confidence?: number;
  status?: CandidateStatus;
  summaryMarkdown?: string;
  whyNowMarkdown?: string;
  earlynessMarkdown?: string;
  scoreComponents?: Record<string, number>;
  searchText?: string;
  embedding?: number[] | null;
  embeddingModel?: string | null;
  sourceCount?: number;
  lastSeenAt?: string;
  briefEvidenceFingerprint?: string | null;
  briefGeneratedAt?: string | null;
  briefModel?: string | null;
  briefPromptVersion?: string | null;
  briefClaimedUntil?: string | null;
}

export interface CriterionProfileVersionInput {
  name?: string;
  lookForMarkdown?: string;
  avoidMarkdown?: string;
  signals?: CriterionSignal[];
  minimumScore?: number;
  minimumConfidence?: number;
  weeklyCandidateCount?: number;
  digestCadence?: import("@/lib/domain/types").DigestCadence;
  digestDaysOfWeek?: number[];
  digestDeliveryHourUtc?: number;
  digestDeliveryMinuteUtc?: number;
  digestPreparationLeadHours?: number;
  learningRate?: number;
  explorationRate?: number;
  trainingSampleCount?: number;
  origin?: "human" | "learned" | "hybrid" | "bootstrap";
  changeSummary?: string | null;
  changeSet?: Json;
  activate?: boolean;
}

export interface RecordCandidateFeedbackInput {
  workspaceId: string | number;
  candidateId: string | number;
  action: "save" | "pass" | "watch" | "refer" | "contact" | "interview" | "accept" | "reject" | "correct_identity";
  actorKey?: string;
  userId?: string | null;
  reasonCode?: string | null;
  note?: string | null;
  weight?: number;
  context?: Json;
}

export interface TasteFeedbackRecord {
  id: string;
  candidateId: string;
  action: string;
  reasonCode: string | null;
  weight: number;
  scoreComponents: Record<string, number>;
  createdAt: string;
}

export interface RankedCandidate {
  candidateId: string;
  slug: string;
  name: string;
  headline: string;
  score: number;
  momentum: number;
  confidence: number;
  latestEventAt: string | null;
  rankScore: number;
}

export type DigestStatus =
  | "draft"
  | "ready"
  | "sending"
  | "sent"
  | "partial"
  | "failed"
  | "cancelled";

export interface DigestRecord {
  id: string;
  workspaceId: string;
  dedupeKey: string;
  criterionProfileId: string | null;
  status: DigestStatus;
  periodStart: string;
  periodEnd: string;
  subject: string;
  previewText: string;
  candidateCount: number;
  recipientCount: number;
  generatedAt: string | null;
  scheduledFor: string | null;
  sentAt: string | null;
  providerMessageId: string | null;
  deliveryMetadata: Json;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDigestResult {
  created: boolean;
  digest: DigestRecord;
}

export interface ClaimDigestDeliveryResult {
  claimed: boolean;
  digest: DigestRecord;
}

export interface CreateDigestInput {
  workspaceId: string | number;
  dedupeKey: string;
  criterionProfileId?: string | number | null;
  periodStart: string;
  periodEnd: string;
  subject: string;
  previewText?: string;
  scheduledFor?: string | null;
  items: Array<{
    candidateId: string | number;
    rank: number;
    section?: "top_discoveries" | "fast_movers" | "network_edge" | "wildcard" | "watchlist_update";
    score: number;
    headline: string;
    summaryMarkdown: string;
    whyNowMarkdown: string;
    evidenceLinks?: EvidenceLink[];
    payloadSnapshot: Json;
  }>;
}

export interface UpdateDigestDeliveryInput {
  status: Exclude<DigestStatus, "draft" | "sending">;
  recipientCount?: number;
  generatedAt?: string | null;
  sentAt?: string | null;
  providerMessageId?: string | null;
  deliveryMetadata?: Json;
}

export interface SubscriberDeliveryUpdate {
  subscriberId: string | number;
  deliveryStatus: DeliveryStatus;
  lastSentAt?: string | null;
  metadata?: Json;
}

export interface DigestSubscriberMutation {
  email?: string;
  displayName?: string | null;
  status?: SubscriberStatus;
  deliveryStatus?: DeliveryStatus;
  lastSentAt?: string | null;
}

export type DataMode = "unconfigured" | "empty" | "live";

export interface DataReadiness {
  dataMode: DataMode;
  missingCapabilities: string[];
  workspaceId: string;
}
