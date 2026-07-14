export type ISODateString = string;

export type CandidateStatus =
  | "new"
  | "watching"
  | "saved"
  | "contacted"
  | "interviewing"
  | "fellow"
  | "passed"
  | "archived";

export type ConfidenceBand = "low" | "medium" | "high";

export type IdentityResolutionStatus =
  | "unresolved"
  | "ambiguous"
  | "resolved"
  | "rejected";

export interface EvidenceLink {
  label: string;
  url: string;
  kind: "primary" | "corroborating" | "social" | "archive";
  excerpt?: string;
}

export interface TalentEvent {
  id: string;
  candidateId: string;
  type: string;
  title: string;
  summaryMarkdown: string;
  evidenceExcerpt?: string;
  whyItMattersMarkdown: string;
  occurredAt: ISODateString | null;
  discoveredAt: ISODateString;
  sourceLabel: string;
  sourceUrl: string;
  confidence: number;
  novelty: number;
  significance: number;
  links: EvidenceLink[];
  metrics?: Record<string, number>;
  tags?: string[];
  raw?: Record<string, unknown>;
}

export interface CandidateIdentity {
  id: string;
  provider: string;
  providerSubjectId: string;
  handle?: string;
  profileUrl?: string;
  displayName: string;
  resolutionStatus: IdentityResolutionStatus;
  confidence: number;
  distinguishingFacts?: string[];
  ambiguityKey?: string;
}

export interface CandidateContactRoute {
  kind:
    | "email"
    | "contact-page"
    | "github"
    | "gitlab"
    | "hacker-news"
    | "x"
    | "linkedin"
    | "website"
    | "institutional";
  label: string;
  url: string;
  provenanceUrl: string;
  confidence: number;
  verified: boolean;
  audience: "direct" | "public-profile" | "institutional";
}

export interface CandidateConnection {
  id: string;
  name: string;
  candidateSlug?: string;
  relationship: string;
  source: string;
  strength: number;
  avatarUrl?: string;
}

export interface Candidate {
  id: string;
  workspaceId: string;
  slug: string;
  name: string;
  initials: string;
  avatarUrl?: string;
  websiteUrl?: string;
  headline: string;
  biography?: string;
  location: string;
  stage: string;
  school?: string;
  affiliations?: string[];
  domains: string[];
  score: number;
  momentum: number;
  confidence: number;
  confidenceBand: ConfidenceBand;
  status: CandidateStatus;
  summaryMarkdown: string;
  briefPolicyVersion?: string | null;
  whyNowMarkdown: string;
  earlynessMarkdown: string;
  latestEvent: TalentEvent | null;
  events: TalentEvent[];
  identities: CandidateIdentity[];
  alternateNames?: Array<{
    name: string;
    sourceUrl: string;
    confidence: number;
    proof: string;
  }>;
  contactRoutes: CandidateContactRoute[];
  connections: CandidateConnection[];
  sourceCount: number;
  firstSeenAt: ISODateString;
  lastSeenAt: ISODateString;
  scoreComponents: Record<string, number>;
}

export interface GraphNode {
  id: string;
  candidateId?: string;
  candidateSlug?: string;
  label: string;
  type:
    | "person"
    | "account"
    | "organization"
    | "project"
    | "paper"
    | "competition"
    | "topic";
  provider: string;
  x?: number;
  y?: number;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  relationship: string;
  strength: number;
  directed: boolean;
}

export interface TalentGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export type SourceStatus = "active" | "paused" | "degraded" | "disabled";

export type StructuredSourceEventType =
  | "competition_result"
  | "hackathon_result"
  | "fellowship_or_grant"
  | "community_recognition";

export interface EditableStructuredSourcePage {
  url: string;
  itemSelector: string;
  nameSelector: string;
  titleSelector?: string;
  descriptionSelector?: string;
  linkSelector?: string;
  dateSelector?: string;
  rankSelector?: string;
  affiliationSelector?: string;
  eventName?: string;
  occurredAt?: string;
  eventType?: StructuredSourceEventType;
}

export interface EditableManualProfile {
  name: string;
  profileUrl: string;
  headline?: string;
  biography?: string;
  location?: string;
  affiliations?: string[];
  websiteUrl?: string;
  observedAt?: string;
  note?: string;
  provenanceUrl?: string;
  reviewed: boolean;
}

export interface EditableSourceOptions {
  complexityKeywords?: string[];
  maxContests?: number;
  feed?: "newstories" | "beststories" | "topstories" | "showstories";
  minimumScore?: number;
  topicKeywords?: string[];
  requireTopicMatch?: boolean;
  maxQueries?: number;
  maxResults?: number;
  pages?: EditableStructuredSourcePage[];
  profiles?: EditableManualProfile[];
}

export interface EditableSourceConfiguration {
  queries?: string[];
  urls?: string[];
  lookbackDays?: number;
  maxItems?: number;
  options?: EditableSourceOptions;
}

export interface DiscoverySource {
  id: string;
  key: string;
  name: string;
  kind: string;
  status: SourceStatus;
  enabled: boolean;
  trustWeight: number;
  cadence: string;
  lastSuccessAt: ISODateString | null;
  nextRunAt: ISODateString | null;
  discoveredThisWeek: number;
  config: EditableSourceConfiguration;
  icon?: string;
}

export interface CriterionSignal {
  key: string;
  label: string;
  description: string;
  weight: number;
  enabled: boolean;
}

export type DigestCadence = "daily" | "twice_weekly" | "weekly" | "biweekly";

export interface CriterionProfile {
  id: string;
  name: string;
  version: number;
  status: "draft" | "active" | "retired";
  lookForMarkdown: string;
  avoidMarkdown: string;
  signals: CriterionSignal[];
  minimumScore: number;
  minimumConfidence: number;
  weeklyCandidateCount: number;
  digestCadence: DigestCadence;
  digestDaysOfWeek: number[];
  digestDeliveryHourUtc: number;
  digestDeliveryMinuteUtc: number;
  digestPreparationLeadHours: number;
  explorationRate: number;
  learningRate: number;
  lastLearnedAt: ISODateString | null;
  trainingSampleCount: number;
}

export type SubscriberStatus = "active" | "paused";
export type DeliveryStatus =
  | "never_sent"
  | "delivered"
  | "bounced"
  | "complained"
  | "failed";

export interface DigestSubscriber {
  id: string;
  workspaceId: string;
  email: string;
  displayName: string | null;
  status: SubscriberStatus;
  deliveryStatus: DeliveryStatus;
  lastSentAt: ISODateString | null;
  createdAt: ISODateString;
}

export interface DashboardMetric {
  label: string;
  value: number;
  change: number;
  format?: "number" | "percent";
}

export interface PipelineActivity {
  id: string;
  source: string;
  status: "queued" | "running" | "succeeded" | "partial" | "failed";
  label: string;
  detail: string;
  timestamp: ISODateString;
}

export interface WeeklyDiscoveryPoint {
  week: string;
  discovered: number;
  surfaced: number;
  saved: number;
}

export interface DashboardData {
  candidates: Candidate[];
  recentEvents: TalentEvent[];
  graph: TalentGraph;
  sources: DiscoverySource[];
  criterion: CriterionProfile;
  subscribers: DigestSubscriber[];
  metrics: DashboardMetric[];
  pipelineActivity: PipelineActivity[];
  weeklyTrend: WeeklyDiscoveryPoint[];
  generatedAt: ISODateString;
}

export interface CandidateSearchOptions {
  limit?: number;
  minimumScore?: number;
  statuses?: CandidateStatus[];
  domains?: string[];
  careerStages?: string[];
  eventTypes?: string[];
  locations?: string[];
  sources?: string[];
  embedding?: number[];
  semanticWeight?: number;
}

export interface CandidateListOptions {
  limit?: number;
  cursor?: { score: number; id: string };
  statuses?: CandidateStatus[];
  domains?: string[];
}

export interface AddDigestSubscriberInput {
  email: string;
  displayName?: string | null;
  status?: SubscriberStatus;
}

export interface UpdateDigestSubscriberInput {
  email?: string;
  displayName?: string | null;
  status?: SubscriberStatus;
  deliveryStatus?: DeliveryStatus;
  lastSentAt?: ISODateString | null;
}
