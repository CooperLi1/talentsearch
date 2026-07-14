import type { CandidateSummary, EventSummary } from "@/lib/ai/schemas";

import type {
  CandidateScore,
  ConnectorCursor,
  DiscoveryEvent,
  DiscoveryRunSummary,
  GraphEdge,
  IdentityCandidate,
  IdentityDecision,
  PersonObservation,
  SourceKind,
} from "./types";

export type EnrichmentTarget = {
  id: string;
  person: PersonObservation;
  events: DiscoveryEvent[];
  previousSummary?: string;
  score?: number;
  briefEvidenceFingerprint?: string;
  researchPass?: number;
  researchRevision?: number;
};

export interface DiscoveryRepository {
  startRun(input: {
    workspaceId: string;
    sources: SourceKind[];
    startedAt: string;
  }): Promise<string>;
  finishRun(input: {
    workspaceId: string;
    runId: string;
    status: "succeeded" | "partial" | "failed";
    summary: DiscoveryRunSummary;
  }): Promise<void>;
  findIdentityCandidates(
    workspaceId: string,
    observation: PersonObservation,
  ): Promise<IdentityCandidate[]>;
  persistIdentityDecision(input: {
    workspaceId: string;
    observation: PersonObservation;
    decision: IdentityDecision;
  }): Promise<{ candidateId: string; created: boolean; reviewQueued: boolean }>;
  upsertEvent(input: {
    workspaceId: string;
    candidateId: string;
    event: DiscoveryEvent;
    summary: EventSummary;
  }): Promise<{ eventId: string; inserted: boolean }>;
  upsertGraphEdges(input: {
    workspaceId: string;
    edges: GraphEdge[];
  }): Promise<void>;
  listEnrichmentTargets(
    workspaceId: string,
    limit: number,
  ): Promise<EnrichmentTarget[]>;
  recordEnrichmentAttempt(input: {
    workspaceId: string;
    candidateId: string;
    attemptedAt: string;
    eventCount: number;
    researchPass?: number;
    researchRevision?: number;
  }): Promise<void>;
  listIntelligenceTargets(
    workspaceId: string,
    limit: number,
  ): Promise<EnrichmentTarget[]>;
  listBriefingTargets(
    workspaceId: string,
    limit: number,
  ): Promise<EnrichmentTarget[]>;
  releaseCandidateBrief(
    workspaceId: string,
    candidateId: string,
  ): Promise<void>;
  listGraphExpansionSeeds(
    workspaceId: string,
    limit: number,
  ): Promise<EnrichmentTarget[]>;
  bindGraphExpansionSeeds(
    workspaceId: string,
    seeds: EnrichmentTarget[],
  ): Promise<void>;
  listCandidateEvents(workspaceId: string, candidateId: string): Promise<DiscoveryEvent[]>;
  updateCandidateIntelligence(input: {
    workspaceId: string;
    candidateId: string;
    score: CandidateScore;
    summary: CandidateSummary;
    embedding: number[] | null;
    embeddingModel: string | null;
    sourceCount?: number;
    persistSummary?: boolean;
    briefEvidenceFingerprint?: string;
    briefGeneratedAt?: string;
    briefModel?: string;
    briefPromptVersion?: string;
  }): Promise<void>;
  saveConnectorCursor(input: {
    workspaceId: string;
    source: SourceKind;
    cursor: ConnectorCursor;
    completedAt: string;
  }): Promise<void>;
}
