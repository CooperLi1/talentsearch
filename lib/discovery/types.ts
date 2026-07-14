import type { CandidateContactRoute } from "@/lib/domain/types";

export const SOURCE_KINDS = [
  "github",
  "gitlab",
  "openalex",
  "crossref",
  "arxiv",
  "semantic-scholar",
  "hugging-face",
  "codeforces",
  "hacker-news",
  "rss",
  "technical-blogs",
  "project-launches",
  "structured-results",
  "competition-results",
  "science-fairs",
  "hackathons",
  "web-presence",
  "x",
  "linkedin-manual",
  "brave-enrichment",
] as const;

export type SourceKind = (typeof SOURCE_KINDS)[number];

export type ExternalIdentity = {
  provider: SourceKind | "orcid" | "email" | "website";
  externalId: string;
  profileUrl?: string;
  username?: string;
  verified?: boolean;
  confidence?: number;
  proof?: "provider-api" | "rel-me" | "jsonld-same-as" | "profile-link" | "search-consensus" | "manual-review";
  proofSourceUrl?: string;
};

export type ObservedName = {
  name: string;
  sourceUrl: string;
  confidence: number;
  proof: "provider-profile" | "jsonld-alternate-name" | "owned-page-author";
};

export type PersonObservation = {
  displayName: string;
  identities: ExternalIdentity[];
  headline?: string;
  biography?: string;
  location?: string;
  affiliations?: string[];
  alternateNames?: ObservedName[];
  emailHash?: string;
  avatarUrl?: string;
  websiteUrl?: string;
  explicitCareerStage?: string;
  contactRoutes?: CandidateContactRoute[];
  sourceUrl: string;
};

export type EventType =
  | "project_created"
  | "project_momentum"
  | "open_source_contribution"
  | "paper_published"
  | "competition_result"
  | "hackathon_result"
  | "community_recognition"
  | "social_graph_signal"
  | "profile_observed"
  | "fellowship_or_grant"
  | "other";

export type EvidenceLink = {
  label: string;
  url: string;
  publishedAt?: string;
};

export type DiscoveryEvent = {
  idempotencyKey: string;
  source: SourceKind;
  sourceExternalId: string;
  type: EventType;
  title: string;
  description?: string;
  occurredAt: string;
  discoveredAt: string;
  sourceUrl: string;
  evidence: EvidenceLink[];
  person: PersonObservation;
  metrics?: Record<string, number>;
  tags?: string[];
  raw?: Record<string, unknown>;
  confidence: number;
};

export type GraphEdge = {
  source: ExternalIdentity;
  target: PersonObservation;
  relation:
    | "follows"
    | "collaborates_with"
    | "coauthors_with"
    | "contributes_to"
    | "engages_with"
    | "competed_with"
    | "mentioned_by";
  weight: number;
  sourceUrl: string;
  observedAt: string;
};

export type ConnectorCursor = Record<string, string | number | boolean | null>;

export type ConnectorSettings = {
  enabled: boolean;
  queries?: string[];
  seedIds?: string[];
  urls?: string[];
  maxItems?: number;
  lookbackDays?: number;
  options?: Record<string, unknown>;
};

export type ConnectorRunContext = {
  now: Date;
  cursor?: ConnectorCursor;
  settings: ConnectorSettings;
  signal?: AbortSignal;
};

export type ConnectorRunResult = {
  events: DiscoveryEvent[];
  edges?: GraphEdge[];
  cursor?: ConnectorCursor;
  warnings?: string[];
};

export type ConnectorEnrichmentContext = {
  now: Date;
  person: PersonObservation;
  evidenceEvents?: DiscoveryEvent[];
  settings: ConnectorSettings;
  researchPass?: number;
  signal?: AbortSignal;
};

export interface DiscoveryConnector {
  readonly kind: SourceKind;
  readonly displayName: string;
  discover(context: ConnectorRunContext): Promise<ConnectorRunResult>;
  enrich?(
    context: ConnectorEnrichmentContext,
  ): Promise<ConnectorRunResult | null>;
  expandGraph?(
    context: ConnectorEnrichmentContext,
  ): Promise<GraphEdge[]>;
}

export type CandidateFeatureVector = {
  achievementQuality: number;
  trajectoryVelocity: number;
  projectOriginality: number;
  technicalComplexity: number;
  networkProximity: number;
  evidenceDiversity: number;
  earlyness: number;
};

export type CandidateScore = {
  total: number;
  features: CandidateFeatureVector;
  confidencePenalty: number;
  stalenessPenalty: number;
  explanations: string[];
};

export type ScoringWeights = CandidateFeatureVector;

export type IdentityCandidate = {
  id: string;
  displayName: string;
  identities: ExternalIdentity[];
  affiliations?: string[];
  location?: string;
  websiteUrl?: string;
  emailHash?: string;
};

export type IdentityDecision =
  | {
      action: "match";
      candidateId: string;
      confidence: number;
      reasons: string[];
    }
  | {
      action: "review";
      possibleCandidateIds: string[];
      confidence: number;
      reasons: string[];
    }
  | {
      action: "create";
      confidence: number;
      reasons: string[];
    };

export type DiscoveryRunSummary = {
  runId: string;
  startedAt: string;
  completedAt: string;
  connectorsRun: number;
  connectorFailures: Array<{ source: SourceKind; message: string }>;
  eventsObserved: number;
  eventsInserted: number;
  candidatesCreated: number;
  candidatesUpdated: number;
  identitiesFlaggedForReview: number;
  enrichedCandidates: number;
};
