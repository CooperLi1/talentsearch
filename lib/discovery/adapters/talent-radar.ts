import type { Candidate, CandidateIdentity, TalentEvent } from "@/lib/domain/types";
import {
  addIdentityCandidateHypothesis,
  createIngestionRun,
  getAllSourceRecords,
  getDueSources,
  getActiveCriterionProfile,
  getCandidateBySlug,
  insertCandidateEvent,
  listCandidates,
  listEnrichmentShortlist,
  listSources,
  mergeCandidateObservation,
  reviewIdentityCandidate,
  searchCandidates,
  updateCandidateIntelligence,
  updateIngestionRun,
  updateSourceCursor,
  upsertCandidate,
  upsertGraphEdge,
  upsertGraphNode,
  upsertIdentityObservation,
} from "@/lib/data/talent-radar";
import type { IdentityResolutionResult } from "@/lib/data/contracts";

import { parseDiscoveryConfiguration } from "../config";
import { stableHash } from "../idempotency";
import type { DiscoveryRepository } from "../repository";
import {
  SOURCE_KINDS,
  type DiscoveryEvent,
  type ExternalIdentity,
  type IdentityCandidate,
  type PersonObservation,
  type SourceKind,
} from "../types";

function slugify(name: string, suffix: string) {
  const base = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 54) || "candidate";
  return `${base}-${suffix.slice(0, 8)}`;
}

function normalizedName(name: string) {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function provider(identity: CandidateIdentity): ExternalIdentity["provider"] {
  const known = [...SOURCE_KINDS, "orcid", "email", "website"] as string[];
  return known.includes(identity.provider)
    ? (identity.provider as ExternalIdentity["provider"])
    : "website";
}

function candidatePerson(candidate: Candidate): PersonObservation {
  return {
    displayName: candidate.name,
    identities: candidate.identities.map((identity) => ({
      provider: provider(identity),
      externalId: identity.handle || identity.profileUrl || identity.id,
      username: identity.handle,
      profileUrl: identity.profileUrl,
      verified: identity.resolutionStatus === "resolved",
    })),
    headline: candidate.headline,
    biography: candidate.summaryMarkdown,
    location: candidate.location,
    affiliations: candidate.school ? [candidate.school] : undefined,
    avatarUrl: candidate.avatarUrl,
    websiteUrl: candidate.websiteUrl,
    sourceUrl:
      candidate.identities.find((identity) => identity.profileUrl)?.profileUrl ||
      `https://unfound.local/candidates/${candidate.slug}`,
  };
}

function sourceKind(label: string): SourceKind {
  const normalized = label.toLowerCase().replaceAll("_", "-") as SourceKind;
  return SOURCE_KINDS.includes(normalized) ? normalized : "structured-results";
}

function domainEvent(event: TalentEvent, person: PersonObservation): DiscoveryEvent {
  const source = sourceKind(event.sourceLabel);
  return {
    idempotencyKey: stableHash("stored-event", event.id),
    source,
    sourceExternalId: event.id,
    type: event.type as DiscoveryEvent["type"],
    title: event.title,
    description: event.summaryMarkdown,
    occurredAt: event.occurredAt ?? event.discoveredAt,
    discoveredAt: event.discoveredAt,
    sourceUrl: event.sourceUrl,
    evidence: event.links.map((link) => ({ label: link.label, url: link.url })),
    person,
    confidence: event.confidence,
  };
}

function json(value: unknown) {
  return JSON.parse(JSON.stringify(value ?? null));
}

export class TalentRadarDiscoveryRepository implements DiscoveryRepository {
  private pendingIdentity = new Map<string, IdentityResolutionResult>();

  async startRun(input: Parameters<DiscoveryRepository["startRun"]>[0]) {
    const run = await createIngestionRun({
      workspaceId: input.workspaceId,
      kind: "scheduled",
      scheduledFor: input.startedAt,
    });
    await updateIngestionRun(run.id, input.workspaceId, {
      status: "running",
      startedAt: input.startedAt,
      metrics: { sources: input.sources },
    });
    return run.id;
  }

  async finishRun(input: Parameters<DiscoveryRepository["finishRun"]>[0]) {
    await updateIngestionRun(input.runId, input.workspaceId, {
      status: input.status,
      finishedAt: input.summary.completedAt,
      discoveredCount: input.summary.candidatesCreated,
      enrichedCount: input.summary.enrichedCandidates,
      eventCount: input.summary.eventsInserted,
      errorCount: input.summary.connectorFailures.length,
      metrics: json(input.summary),
      errorMessage: input.summary.connectorFailures.map((failure) => failure.message).join("; ") || null,
    });
  }

  async findIdentityCandidates(workspaceId: string, observation: PersonObservation) {
    const identity = observation.identities[0];
    if (!identity) return [];
    const resolution = await upsertIdentityObservation({
      workspaceId,
      provider: identity.provider,
      providerSubjectId: identity.externalId,
      handle: identity.username,
      profileUrl: identity.profileUrl,
      displayName: observation.displayName,
      normalizedName: normalizedName(observation.displayName),
      confidence: identity.verified ? 0.95 : 0.55,
      matchMethod: "pipeline-observation",
      evidence: [{ sourceUrl: observation.sourceUrl }],
    });
    this.pendingIdentity.set(stableHash(identity.provider, identity.externalId), resolution);
    const [searchedCandidates, resolvedCandidates] = await Promise.all([
      searchCandidates(observation.displayName, { limit: 10 }, workspaceId),
      Promise.all(
        resolution.matches.map((match) => getCandidateBySlug(match.candidateId, workspaceId)),
      ),
    ]);
    const byId = new Map(
      [...searchedCandidates, ...resolvedCandidates.filter((candidate) => candidate !== null)].map(
        (candidate) => [candidate.id, candidate],
      ),
    );
    return resolution.matches
      .map((match): IdentityCandidate | null => {
        const candidate = byId.get(match.candidateId);
        if (!candidate) return null;
        return {
          id: candidate.id,
          displayName: candidate.name,
          identities: match.exactProviderMatch
            ? [identity, ...candidatePerson(candidate).identities]
            : candidatePerson(candidate).identities,
          affiliations: candidate.school ? [candidate.school] : undefined,
          location: candidate.location,
          websiteUrl: candidate.websiteUrl,
        };
      })
      .filter((item): item is IdentityCandidate => Boolean(item));
  }

  async persistIdentityDecision(input: Parameters<DiscoveryRepository["persistIdentityDecision"]>[0]) {
    const identity = input.observation.identities[0];
    if (!identity) throw new Error("Observation has no identity");
    const key = stableHash(identity.provider, identity.externalId);
    const pending = this.pendingIdentity.get(key);
    if (input.decision.action === "match") {
      await upsertIdentityObservation({
        workspaceId: input.workspaceId,
        provider: identity.provider,
        providerSubjectId: identity.externalId,
        handle: identity.username,
        profileUrl: identity.profileUrl,
        displayName: input.observation.displayName,
        normalizedName: normalizedName(input.observation.displayName),
        candidateId: input.decision.candidateId,
        confidence: input.decision.confidence,
        matchMethod: input.decision.reasons.join("; "),
        evidence: [{ sourceUrl: input.observation.sourceUrl }],
      });
      if (pending?.identityId && pending.status !== "resolved") {
        await reviewIdentityCandidate({
          workspaceId: input.workspaceId,
          identityId: pending.identityId,
          candidateId: input.decision.candidateId,
          decision: "accepted",
        }).catch(() => undefined);
      }
      await mergeCandidateObservation({
        workspaceId: input.workspaceId,
        candidateId: input.decision.candidateId,
        displayName: input.observation.displayName,
        headline: input.observation.headline,
        biography: input.observation.biography,
        location: input.observation.location,
        affiliations: input.observation.affiliations,
        avatarUrl: input.observation.avatarUrl,
        websiteUrl: input.observation.websiteUrl,
        sourceUrl: input.observation.sourceUrl,
        provider: identity.provider,
        providerSubjectId: identity.externalId,
        providerHandle: identity.username,
        providerProfileUrl: identity.profileUrl,
        providerVerified: identity.verified === true,
      });
      return { candidateId: input.decision.candidateId, created: false, reviewQueued: false };
    }

    const candidateId = await upsertCandidate({
      workspaceId: input.workspaceId,
      slug: slugify(input.observation.displayName, key),
      name: input.observation.displayName,
      headline: input.observation.headline,
      location: input.observation.location,
      avatarUrl: input.observation.avatarUrl,
      domains: [],
      confidence: input.decision.confidence,
      attributes: json({
        affiliations: input.observation.affiliations,
        provisional: input.decision.action === "review",
        nameProvenance: {
          name: input.observation.displayName,
          kind:
            identity.username &&
            normalizedName(identity.username) === normalizedName(input.observation.displayName)
              ? "provider-handle"
              : "source-observation",
          automated: Boolean(
            identity.username &&
              normalizedName(identity.username) === normalizedName(input.observation.displayName),
          ),
          provider: identity.provider,
          providerSubjectId: identity.externalId,
          sourceUrl: input.observation.sourceUrl,
          observedAt: new Date().toISOString(),
        },
      }),
      lastSeenAt: new Date().toISOString(),
    });
    if (input.decision.action === "review") {
      if (pending?.identityId) {
        for (const possibleCandidateId of input.decision.possibleCandidateIds) {
          await addIdentityCandidateHypothesis({
            workspaceId: input.workspaceId,
            identityId: pending.identityId,
            candidateId: possibleCandidateId,
            score: input.decision.confidence,
            signals: { reasons: input.decision.reasons },
          });
        }
      }
      return { candidateId, created: true, reviewQueued: true };
    }
    await upsertIdentityObservation({
      workspaceId: input.workspaceId,
      provider: identity.provider,
      providerSubjectId: identity.externalId,
      handle: identity.username,
      profileUrl: identity.profileUrl,
      displayName: input.observation.displayName,
      normalizedName: normalizedName(input.observation.displayName),
      candidateId,
      confidence: input.decision.confidence,
      matchMethod: input.decision.reasons.join("; "),
      evidence: [{ sourceUrl: input.observation.sourceUrl }],
    });
    await mergeCandidateObservation({
      workspaceId: input.workspaceId,
      candidateId,
      displayName: input.observation.displayName,
      headline: input.observation.headline,
      biography: input.observation.biography,
      location: input.observation.location,
      affiliations: input.observation.affiliations,
      avatarUrl: input.observation.avatarUrl,
      websiteUrl: input.observation.websiteUrl,
      sourceUrl: input.observation.sourceUrl,
      provider: identity.provider,
      providerSubjectId: identity.externalId,
      providerHandle: identity.username,
      providerProfileUrl: identity.profileUrl,
      providerVerified: identity.verified === true,
    });
    return { candidateId, created: true, reviewQueued: false };
  }

  async upsertEvent(input: Parameters<DiscoveryRepository["upsertEvent"]>[0]) {
    const eventId = await insertCandidateEvent({
      workspaceId: input.workspaceId,
      candidateId: input.candidateId,
      eventType: input.event.type,
      title: input.event.title,
      summaryMarkdown: input.summary.summary,
      whyItMattersMarkdown: input.summary.whyNow,
      occurredAt: input.event.occurredAt,
      discoveredAt: input.event.discoveredAt,
      sourceUrl: input.event.sourceUrl,
      sourceLabel: input.event.source,
      externalId: input.event.sourceExternalId,
      contentHash: input.event.idempotencyKey,
      evidenceExcerpt: input.event.description,
      confidence: input.event.confidence,
      novelty: input.event.metrics?.momentum ? Math.min(100, input.event.metrics.momentum) : 0,
      significance: 0,
      rawPayload: json(input.event.raw ?? {}),
      llmModel: null,
      promptVersion: "grounded-v1",
      evidenceLinks: input.event.evidence.map((link) => ({
        label: link.label,
        url: link.url,
        kind: "primary",
      })),
    });
    return { eventId, inserted: true };
  }

  async upsertGraphEdges(input: Parameters<DiscoveryRepository["upsertGraphEdges"]>[0]) {
    for (const edge of input.edges) {
      const targetIdentity = edge.target.identities[0];
      if (!targetIdentity) continue;
      const from = await upsertGraphNode({
        workspaceId: input.workspaceId,
        nodeType: "account",
        provider: edge.source.provider,
        externalKey: edge.source.externalId,
        label: edge.source.username || edge.source.externalId,
        url: edge.source.profileUrl,
      });
      const to = await upsertGraphNode({
        workspaceId: input.workspaceId,
        nodeType: "account",
        provider: targetIdentity.provider,
        externalKey: targetIdentity.externalId,
        label: edge.target.displayName,
        url: targetIdentity.profileUrl,
      });
      if (from === to) continue;
      await upsertGraphEdge({
        workspaceId: input.workspaceId,
        fromNodeId: from,
        toNodeId: to,
        relationshipType: edge.relation,
        strength: edge.weight,
        observedAt: edge.observedAt,
        metadata: { sourceUrl: edge.sourceUrl },
      });
    }
  }

  async listEnrichmentTargets(workspaceId: string, limit: number) {
    const candidates = await listEnrichmentShortlist(workspaceId, limit);
    return candidates.map((candidate) => {
      const person = candidatePerson(candidate);
      return {
        id: candidate.id,
        person,
        events: candidate.events.map((event) => domainEvent(event, person)),
        previousSummary: candidate.summaryMarkdown,
        score: candidate.score,
      };
    });
  }

  async listCandidateEvents(workspaceId: string, candidateId: string) {
    const candidates = await listCandidates({ limit: 500 }, workspaceId);
    const candidate = candidates.find((item) => item.id === candidateId);
    if (!candidate) return [];
    const person = candidatePerson(candidate);
    return candidate.events.map((event) => domainEvent(event, person));
  }

  async updateCandidateIntelligence(input: Parameters<DiscoveryRepository["updateCandidateIntelligence"]>[0]) {
    await updateCandidateIntelligence({
      workspaceId: input.workspaceId,
      candidateId: input.candidateId,
      score: input.score.total,
      confidence: Math.max(0, 1 - input.score.confidencePenalty),
      summaryMarkdown: input.summary.summary,
      whyNowMarkdown: input.summary.whyNow,
      earlynessMarkdown: input.summary.earlyness,
      scoreComponents: input.score.features,
      searchText: [
        input.summary.headline,
        input.summary.summary,
        input.summary.demonstratedStrengths.join(" "),
      ].join("\n"),
      embedding: input.embedding,
      embeddingModel: input.embeddingModel,
      lastSeenAt: new Date().toISOString(),
    });
  }

  async saveConnectorCursor(input: Parameters<DiscoveryRepository["saveConnectorCursor"]>[0]) {
    const sources = await listSources(input.workspaceId);
    const source = sources.find((item) => item.key === input.source || item.kind === input.source);
    if (!source) return;
    const nextRunAt = new Date(new Date(input.completedAt).getTime() + 86_400_000).toISOString();
    await updateSourceCursor(source.id, input.workspaceId, json(input.cursor), nextRunAt);
  }
}

export function createTalentRadarDiscoveryRepository() {
  return new TalentRadarDiscoveryRepository();
}

export async function loadSourceConfiguration(workspaceId: string, dueOnly: boolean) {
  const eligible = dueOnly
    ? await getDueSources(workspaceId, 100)
    : await getAllSourceRecords(workspaceId, 100);
  const connectors: Record<string, unknown> = Object.fromEntries(
    SOURCE_KINDS.map((kind) => [kind, { enabled: false }]),
  );
  for (const source of eligible) {
    if (!SOURCE_KINDS.includes(source.kind as SourceKind)) continue;
    const sourceConfig = source.config && typeof source.config === "object" && !Array.isArray(source.config)
      ? source.config
      : {};
    connectors[source.kind] = {
      ...sourceConfig,
      enabled: true,
      maxItems: Math.min(500, Math.max(1, source.maxRequestsPerRun)),
      ...(source.baseUrl && !("urls" in sourceConfig) ? { urls: [source.baseUrl] } : {}),
    };
  }
  const profile = await getActiveCriterionProfile(workspaceId);
  const aliases: Record<string, string> = {
    originality: "projectOriginality",
    technical_complexity: "technicalComplexity",
    velocity: "trajectoryVelocity",
    network: "networkProximity",
    achievement: "achievementQuality",
    diversity: "evidenceDiversity",
    earlyness: "earlyness",
  };
  const scoringWeights = profile
    ? Object.fromEntries(profile.signals.map((signal) => [aliases[signal.key] ?? signal.key, signal.enabled ? signal.weight : 0]))
    : undefined;
  return parseDiscoveryConfiguration({
    connectors,
    minimumScore: profile?.minimumScore,
    scoringWeights,
    enrichTopCandidates: profile?.weeklyCandidateCount,
  });
}
