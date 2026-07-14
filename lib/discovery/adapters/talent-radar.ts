import type { Candidate, CandidateIdentity, TalentEvent } from "@/lib/domain/types";
import { briefEvidenceDescription } from "@/lib/candidates/brief-evidence";
import { CURRENT_CANDIDATE_BRIEF_POLICY } from "@/lib/candidates/brief-policy";
import {
  addIdentityCandidateHypothesis,
  createIngestionRun,
  claimCandidateBriefingBacklog,
  getAllSourceRecords,
  getDueSources,
  getActiveCriterionProfile,
  getCandidateBySlug,
  insertCandidateEvent,
  listCandidates,
  listAutomaticReviewShortlist,
  listEnrichmentShortlist,
  listSources,
  mergeCandidateObservation,
  recordCandidateEnrichmentAttempt,
  reviewIdentityCandidate,
  releaseCandidateBriefClaim,
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
import type { DiscoveryRepository, EnrichmentTarget } from "../repository";
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
      externalId: identity.providerSubjectId,
      username: identity.handle,
      profileUrl: identity.profileUrl,
      verified: identity.resolutionStatus === "resolved",
    })),
    headline: candidate.headline,
    // Only provider- or site-observed biography text belongs in discovery
    // context. Feeding an earlier model brief back into research can turn a
    // weak summary into apparent source evidence on the next pass.
    biography: candidate.biography,
    location: candidate.location,
    affiliations: candidate.affiliations?.length
      ? candidate.affiliations
      : candidate.school
        ? [candidate.school]
        : undefined,
    alternateNames: (candidate.alternateNames ?? []).map((item) => ({
      name: item.name,
      sourceUrl: item.sourceUrl,
      confidence: item.confidence,
      proof: item.proof as "provider-profile" | "jsonld-alternate-name" | "owned-page-author",
    })),
    avatarUrl: candidate.avatarUrl,
    websiteUrl: candidate.websiteUrl,
    explicitCareerStage: [
      candidate.stage,
      candidate.school,
      ...(candidate.affiliations ?? []),
      ...candidate.events.flatMap((event) => [event.type, event.title, event.sourceLabel]),
    ].filter(Boolean).join(" "),
    contactRoutes: candidate.contactRoutes,
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
    // Candidate briefs must read the connector's extracted public evidence,
    // not a prior model's event summary. Otherwise one hallucination becomes
    // the next model call's apparent source material.
    description: briefEvidenceDescription(event),
    occurredAt: event.occurredAt ?? event.discoveredAt,
    discoveredAt: event.discoveredAt,
    sourceUrl: event.sourceUrl,
    evidence: event.links.map((link) => ({ label: link.label, url: link.url })),
    person,
    metrics: event.metrics,
    tags: event.tags,
    raw: event.raw,
    confidence: event.confidence,
  };
}

function json(value: unknown) {
  return JSON.parse(JSON.stringify(value ?? null));
}

async function bindCandidateGraphNodes(input: {
  workspaceId: string;
  candidateId: string;
  observation: PersonObservation;
}) {
  for (const identity of input.observation.identities
    .filter(
      (item) => item.provider !== "email" && item.verified === true && item.externalId.trim(),
    )
    .slice(0, 10)) {
    await upsertGraphNode({
      workspaceId: input.workspaceId,
      candidateId: input.candidateId,
      nodeType: "account",
      provider: identity.provider,
      externalKey: identity.externalId,
      label: input.observation.displayName,
      url: identity.profileUrl,
    });
  }
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
    const identities = observation.identities.slice(0, 10);
    if (!identities.length) return [];
    const resolved = await Promise.all(
      identities.map(async (identity) => {
        const resolution = await upsertIdentityObservation({
          workspaceId,
          provider: identity.provider,
          providerSubjectId: identity.externalId,
          handle: identity.username,
          profileUrl: identity.profileUrl,
          displayName: observation.displayName,
          normalizedName: normalizedName(observation.displayName),
          confidence: identity.verified
            ? Math.max(0.95, identity.confidence ?? 0)
            : Math.max(0.5, Math.min(0.85, identity.confidence ?? 0.55)),
          matchMethod: "pipeline-observation",
          evidence: [{ sourceUrl: observation.sourceUrl }],
        });
        this.pendingIdentity.set(
          stableHash(identity.provider, identity.externalId),
          resolution,
        );
        return { identity, resolution };
      }),
    );
    const candidateIds = [
      ...new Set(
        resolved.flatMap(({ resolution }) =>
          resolution.matches.map((match) => match.candidateId),
        ),
      ),
    ];
    const candidates = await Promise.all(
      candidateIds.map((candidateId) => getCandidateBySlug(candidateId, workspaceId)),
    );
    return candidates.flatMap((candidate): IdentityCandidate[] => {
      if (!candidate) return [];
      const exactObservedIdentities = resolved.flatMap(({ identity, resolution }) =>
        resolution.matches.some(
          (match) => match.candidateId === candidate.id && match.exactProviderMatch,
        )
          ? [identity]
          : [],
      );
      const candidateIdentities = candidatePerson(candidate).identities;
      const seen = new Set<string>();
      const combinedIdentities = [...exactObservedIdentities, ...candidateIdentities].filter(
        (identity) => {
          const key = `${identity.provider}:${identity.externalId}`.toLocaleLowerCase("en-US");
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        },
      );
      return [{
        id: candidate.id,
        displayName: candidate.name,
        identities: combinedIdentities,
        affiliations: candidate.school ? [candidate.school] : undefined,
        location: candidate.location,
        websiteUrl: candidate.websiteUrl,
      }];
    });
  }

  private async bindObservationIdentities(input: {
    workspaceId: string;
    candidateId: string;
    observation: PersonObservation;
    confidence: number;
    reasons: string[];
  }) {
    for (const [index, identity] of input.observation.identities.slice(0, 10).entries()) {
      // The primary identity is the source of the observation. Additional
      // identities only bind automatically after their provider subject was
      // verified (for example, GitHub's numeric user ID).
      const canBind = index === 0 || identity.verified === true;
      const resolution = await upsertIdentityObservation({
        workspaceId: input.workspaceId,
        provider: identity.provider,
        providerSubjectId: identity.externalId,
        handle: identity.username,
        profileUrl: identity.profileUrl,
        displayName: input.observation.displayName,
        normalizedName: normalizedName(input.observation.displayName),
        candidateId: canBind ? input.candidateId : undefined,
        confidence: canBind
          ? Math.max(input.confidence, identity.confidence ?? 0)
          : Math.min(identity.confidence ?? input.confidence, 0.85),
        matchMethod: canBind
          ? index === 0
            ? input.reasons.join("; ")
            : "verified-profile-link-and-provider-subject"
          : "unverified-profile-link-review",
        distinguishingFacts: {
          linkedFromProvider: input.observation.identities[0]?.provider,
          linkedFromUrl: input.observation.sourceUrl,
          providerSubjectVerified: identity.verified === true,
          proof: identity.proof,
          proofSourceUrl: identity.proofSourceUrl,
        },
        evidence: [{ sourceUrl: identity.proofSourceUrl || input.observation.sourceUrl }],
      });
      this.pendingIdentity.set(
        stableHash(identity.provider, identity.externalId),
        resolution,
      );
      const conflictsWithResolvedCandidate = Boolean(
        resolution.candidateId && resolution.candidateId !== input.candidateId,
      );
      const failedToBind = canBind && resolution.candidateId !== input.candidateId;
      if (!canBind || conflictsWithResolvedCandidate || failedToBind) {
        await addIdentityCandidateHypothesis({
          workspaceId: input.workspaceId,
          identityId: resolution.identityId,
          candidateId: input.candidateId,
          score: conflictsWithResolvedCandidate ? 0.5 : Math.min(input.confidence, 0.75),
          signals: {
            reasons: conflictsWithResolvedCandidate
              ? ["Provider identity is already resolved to another candidate"]
              : failedToBind
                ? ["Provider subject conflicts with an identity using the same profile URL"]
                : ["Linked profile lacks a verified provider subject ID"],
            sourceUrl: input.observation.sourceUrl,
          },
        });
      }
    }
  }

  async persistIdentityDecision(input: Parameters<DiscoveryRepository["persistIdentityDecision"]>[0]) {
    const identity = input.observation.identities[0];
    if (!identity) throw new Error("Observation has no identity");
    const key = stableHash(identity.provider, identity.externalId);
    const pending = this.pendingIdentity.get(key);
    if (input.decision.action === "match") {
      await this.bindObservationIdentities({
        workspaceId: input.workspaceId,
        candidateId: input.decision.candidateId,
        observation: input.observation,
        confidence: input.decision.confidence,
        reasons: input.decision.reasons,
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
        alternateNames: input.observation.alternateNames,
        avatarUrl: input.observation.avatarUrl,
        websiteUrl: input.observation.websiteUrl,
        sourceUrl: input.observation.sourceUrl,
        provider: identity.provider,
        providerSubjectId: identity.externalId,
        providerHandle: identity.username,
        providerProfileUrl: identity.profileUrl,
        providerVerified: identity.verified === true,
        contactRoutes: input.observation.contactRoutes,
      });
      await bindCandidateGraphNodes({
        workspaceId: input.workspaceId,
        candidateId: input.decision.candidateId,
        observation: input.observation,
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
    await this.bindObservationIdentities({
      workspaceId: input.workspaceId,
      candidateId,
      observation: input.observation,
      confidence: input.decision.confidence,
      reasons: input.decision.reasons,
    });
    await mergeCandidateObservation({
      workspaceId: input.workspaceId,
      candidateId,
      displayName: input.observation.displayName,
      headline: input.observation.headline,
      biography: input.observation.biography,
      location: input.observation.location,
      affiliations: input.observation.affiliations,
      alternateNames: input.observation.alternateNames,
      avatarUrl: input.observation.avatarUrl,
      websiteUrl: input.observation.websiteUrl,
      sourceUrl: input.observation.sourceUrl,
      provider: identity.provider,
      providerSubjectId: identity.externalId,
      providerHandle: identity.username,
      providerProfileUrl: identity.profileUrl,
      providerVerified: identity.verified === true,
      contactRoutes: input.observation.contactRoutes,
    });
    await bindCandidateGraphNodes({
      workspaceId: input.workspaceId,
      candidateId,
      observation: input.observation,
    });
    return { candidateId, created: true, reviewQueued: false };
  }

  async upsertEvent(input: Parameters<DiscoveryRepository["upsertEvent"]>[0]) {
    const stored = await insertCandidateEvent({
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
      rawPayload: json({
        ...(input.event.raw ?? {}),
        metrics: input.event.metrics ?? {},
        tags: input.event.tags ?? [],
      }),
      llmModel: null,
      promptVersion: "grounded-v1",
      evidenceLinks: input.event.evidence.map((link) => ({
        label: link.label,
        url: link.url,
        kind: "primary",
      })),
    });
    return stored;
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
    const claimed = await listEnrichmentShortlist(workspaceId, limit);
    return claimed.map(({ candidate, researchPass, researchRevision }) => {
      const person = candidatePerson(candidate);
      return {
        id: candidate.id,
        person,
        events: candidate.events.map((event) => domainEvent(event, person)),
        previousSummary: candidate.summaryMarkdown,
        score: candidate.score,
        researchPass,
        researchRevision,
      };
    });
  }

  async recordEnrichmentAttempt(
    input: Parameters<DiscoveryRepository["recordEnrichmentAttempt"]>[0],
  ) {
    await recordCandidateEnrichmentAttempt(input);
  }

  async listIntelligenceTargets(workspaceId: string, limit: number) {
    const candidates = await listAutomaticReviewShortlist(workspaceId, limit);
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

  async listBriefingTargets(workspaceId: string, limit: number) {
    const claimed = await claimCandidateBriefingBacklog(workspaceId, limit);
    return claimed.map(({ candidate, evidenceFingerprint }) => {
      const person = candidatePerson(candidate);
      return {
        id: candidate.id,
        person,
        events: candidate.events.map((event) => domainEvent(event, person)),
        previousSummary: candidate.summaryMarkdown,
        score: candidate.score,
        briefEvidenceFingerprint: evidenceFingerprint,
      };
    });
  }

  async releaseCandidateBrief(workspaceId: string, candidateId: string) {
    await releaseCandidateBriefClaim(workspaceId, candidateId);
  }

  async listGraphExpansionSeeds(workspaceId: string, limit: number) {
    const boundedLimit = Math.min(25, Math.max(0, Math.floor(limit)));
    if (!boundedLimit) return [];
    const candidates = await listCandidates({ limit: Math.min(200, boundedLimit * 8) }, workspaceId);
    return candidates
      .filter((candidate) => {
        if (candidate.status === "archived" || candidate.score < 35) return false;
        const components = candidate.scoreComponents;
        const substantiveSignal = Math.max(
          components.achievementQuality ?? 0,
          components.projectOriginality ?? 0,
          components.technicalComplexity ?? 0,
          components.trajectoryVelocity ?? 0,
        );
        const expandableIdentity = candidate.identities.some(
          (identity) =>
            identity.resolutionStatus === "resolved" &&
            ["github", "openalex", "semantic-scholar", "hacker-news", "x"].includes(
              identity.provider,
            ),
        );
        return substantiveSignal >= 0.3 && expandableIdentity;
      })
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.sourceCount - left.sourceCount ||
          left.id.localeCompare(right.id),
      )
      .slice(0, boundedLimit)
      .map((candidate) => {
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

  async bindGraphExpansionSeeds(workspaceId: string, seeds: EnrichmentTarget[]) {
    for (const seed of seeds.slice(0, 25)) {
      await bindCandidateGraphNodes({
        workspaceId,
        candidateId: seed.id,
        observation: seed.person,
      });
    }
  }

  async listCandidateEvents(workspaceId: string, candidateId: string) {
    const candidates = await listCandidates({ limit: 500 }, workspaceId);
    const candidate = candidates.find((item) => item.id === candidateId);
    if (!candidate) return [];
    const person = candidatePerson(candidate);
    return candidate.events.map((event) => domainEvent(event, person));
  }

  async updateCandidateIntelligence(input: Parameters<DiscoveryRepository["updateCandidateIntelligence"]>[0]) {
    const summaryUpdate = input.persistSummary === false
      ? {}
      : {
          summaryMarkdown: input.summary.summary,
          whyNowMarkdown: input.summary.whyNow,
          earlynessMarkdown: input.summary.earlyness,
          searchText: [
            input.summary.headline,
            input.summary.summary,
            input.summary.demonstratedStrengths.join(" "),
          ].join("\n"),
          ...(input.embedding
            ? { embedding: input.embedding, embeddingModel: input.embeddingModel }
            : {}),
          briefEvidenceFingerprint: input.briefEvidenceFingerprint,
          briefGeneratedAt: input.briefGeneratedAt,
          briefModel: input.briefModel,
          briefPromptVersion: input.briefPromptVersion ?? CURRENT_CANDIDATE_BRIEF_POLICY,
          briefClaimedUntil: null,
        };
    await updateCandidateIntelligence({
      workspaceId: input.workspaceId,
      candidateId: input.candidateId,
      score: input.score.total,
      confidence: Math.max(0, 1 - input.score.confidencePenalty),
      scoreComponents: input.score.features,
      ...(input.sourceCount !== undefined ? { sourceCount: input.sourceCount } : {}),
      lastSeenAt: new Date().toISOString(),
      ...summaryUpdate,
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
  const requestedEnrichmentLimit = Number(process.env.DISCOVERY_ENRICHMENT_LIMIT ?? 10);
  const enrichmentLimit = Number.isFinite(requestedEnrichmentLimit)
    ? Math.min(5, Math.max(0, Math.floor(requestedEnrichmentLimit)))
    : 5;
  return parseDiscoveryConfiguration({
    connectors,
    minimumScore: profile?.minimumScore,
    scoringWeights,
    // Evidence collection is a rotating research backlog, not a function of
    // how many names fit in an email.
    enrichTopCandidates: enrichmentLimit,
  });
}
