import {
  buildCandidateEmbeddingText,
  DEFAULT_EMBEDDING_MODEL,
  embedCandidateTexts,
} from "@/lib/ai/embeddings";
import {
  candidateBriefContractIssues,
  fallbackCandidateSummary,
  fallbackEventSummary,
  generateCandidateBrief,
  summarizeEvent,
} from "@/lib/ai/summaries";
import { CURRENT_CANDIDATE_BRIEF_POLICY } from "@/lib/candidates/brief-policy";

import { parseDiscoveryConfiguration, type DiscoveryConfiguration } from "./config";
import { createConnectorRegistry } from "./connectors";
import { mapLimit } from "./connectors/shared";
import { deduplicateEvents } from "./idempotency";
import { evidencePublisherCount } from "./evidence-publishers";
import { enrichPeople } from "./enrichment";
import { expandDiscoveryGraph, graphEdgesToCandidateEvents } from "./graph";
import { resolveIdentity } from "./identity";
import type { DiscoveryRepository, EnrichmentTarget } from "./repository";
import { scoreCandidate } from "./scoring";
import type {
  ConnectorRunResult,
  DiscoveryEvent,
  DiscoveryRunSummary,
  PersonObservation,
  SourceKind,
  ScoringWeights,
} from "./types";

type RunOptions = {
  repository: DiscoveryRepository;
  workspaceId: string;
  configuration?: DiscoveryConfiguration;
  sourceKinds?: SourceKind[];
  boundedEventLimit?: number;
  graphExpansion?: boolean;
  intelligenceRefreshLimit?: number;
  aiEventSummaryLimit?: number;
  signal?: AbortSignal;
};

function eventPriority(event: DiscoveryEvent) {
  const metrics = event.metrics ?? {};
  return (
    event.confidence * 10 +
    Math.log1p(metrics.momentum ?? 0) +
    Math.log1p(metrics.citations ?? 0) +
    Math.log1p(metrics.graphSupportWeight ?? 0) * 2 +
    Math.log1p(metrics.graphSourceIdentities ?? 0) +
    (metrics.rank ? 4 / Math.sqrt(metrics.rank) : 0)
  );
}

async function persistObservedEvents(input: {
  repository: DiscoveryRepository;
  workspaceId: string;
  events: DiscoveryEvent[];
  aiSummaryKeys: Set<string>;
}) {
  let eventsInserted = 0;
  const createdCandidateIds = new Set<string>();
  const updatedCandidateIds = new Set<string>();
  const reviewedCandidateIds = new Set<string>();
  const affected = new Map<
    string,
    { person: PersonObservation; events: DiscoveryEvent[] }
  >();
  const candidateByVerifiedIdentity = new Map<string, string>();

  for (const event of input.events) {
    const primaryIdentity = event.person.identities[0];
    const durableIdentityKey = primaryIdentity?.verified === true
      ? `${primaryIdentity.provider}:${primaryIdentity.externalId}`.toLocaleLowerCase("en-US")
      : null;
    const alreadyBoundCandidateId = durableIdentityKey
      ? candidateByVerifiedIdentity.get(durableIdentityKey)
      : undefined;
    const decision = alreadyBoundCandidateId
      ? {
          action: "match" as const,
          candidateId: alreadyBoundCandidateId,
          confidence: 1,
          reasons: ["Same verified provider subject resolved earlier in this batch"],
        }
      : resolveIdentity(
          event.person,
          await input.repository.findIdentityCandidates(input.workspaceId, event.person),
        );
    const persisted = await input.repository.persistIdentityDecision({
      workspaceId: input.workspaceId,
      observation: event.person,
      decision,
    });
    if (durableIdentityKey) {
      candidateByVerifiedIdentity.set(durableIdentityKey, persisted.candidateId);
    }
    if (persisted.created) {
      createdCandidateIds.add(persisted.candidateId);
      updatedCandidateIds.delete(persisted.candidateId);
    } else if (!createdCandidateIds.has(persisted.candidateId)) {
      updatedCandidateIds.add(persisted.candidateId);
    }
    if (persisted.reviewQueued) reviewedCandidateIds.add(persisted.candidateId);

    const summary = input.aiSummaryKeys.has(event.idempotencyKey)
      ? await summarizeEvent(event)
      : fallbackEventSummary(event);
    const stored = await input.repository.upsertEvent({
      workspaceId: input.workspaceId,
      candidateId: persisted.candidateId,
      event,
      summary,
    });
    if (stored.inserted) eventsInserted += 1;
    const aggregate = affected.get(persisted.candidateId) ?? {
      person: event.person,
      events: [],
    };
    aggregate.events.push(event);
    affected.set(persisted.candidateId, aggregate);
  }

  return {
    eventsInserted,
    createdCandidateIds,
    updatedCandidateIds,
    reviewedCandidateIds,
    affected,
  };
}

type PersistedEvents = Awaited<ReturnType<typeof persistObservedEvents>>;

function uniqueRunEvents(events: DiscoveryEvent[], seen: Set<string>, limit?: number) {
  const unique: DiscoveryEvent[] = [];
  for (const event of deduplicateEvents(events)) {
    if (seen.has(event.idempotencyKey)) continue;
    seen.add(event.idempotencyKey);
    unique.push(event);
    if (limit !== undefined && unique.length >= limit) break;
  }
  return unique;
}

async function refreshIntelligence(input: {
  repository: DiscoveryRepository;
  workspaceId: string;
  targets: EnrichmentTarget[];
  runEvents?: Map<string, DiscoveryEvent[]>;
  weights?: ScoringWeights;
}) {
  const prepared = await mapLimit(input.targets, 3, async (target) => {
    // A fresh enrichment aggregate contains only events from this run. Reload
    // the persisted history before scoring affected candidates so a profile
    // locator cannot erase years of substantive evidence and reset the score.
    const affectedThisRun = input.runEvents?.has(target.id) ?? false;
    const storedEvents = affectedThisRun || !target.events.length
      ? await input.repository.listCandidateEvents(input.workspaceId, target.id)
      : target.events;
    const events = deduplicateEvents([
      ...storedEvents,
      ...(input.runEvents?.get(target.id) ?? []),
    ]);
    const score = scoreCandidate({ events, weights: input.weights });
    const summary = fallbackCandidateSummary(target.person, events, score);
    return {
      target,
      events,
      score,
      summary,
    };
  });
  await mapLimit(prepared, 3, async (item) => {
    await input.repository.updateCandidateIntelligence({
      workspaceId: input.workspaceId,
      candidateId: item.target.id,
      score: item.score,
      summary: item.summary,
      embedding: null,
      embeddingModel: null,
      persistSummary: false,
      sourceCount: evidencePublisherCount(item.events),
    });
  });
  return prepared.map((item) => ({ candidateId: item.target.id, score: item.score }));
}

export async function runCandidateBriefBatch(input: {
  repository: DiscoveryRepository;
  workspaceId: string;
  limit?: number;
  weights?: ScoringWeights;
}) {
  const limit = Math.min(30, Math.max(0, Math.floor(input.limit ?? 12)));
  if (!limit) return { claimed: 0, completed: 0, failed: 0 };
  const targets = await input.repository.listBriefingTargets(input.workspaceId, limit);
  let generationFailures = 0;
  let contractFailures = 0;
  const prepared = await mapLimit(targets, 3, async (target) => {
    try {
      const events = deduplicateEvents(
        target.events.length
          ? target.events
          : await input.repository.listCandidateEvents(input.workspaceId, target.id),
      );
      const score = scoreCandidate({ events, weights: input.weights });
      const summary = await generateCandidateBrief({
        person: target.person,
        events,
        score,
        previousSummary: target.previousSummary,
      });
      if (!summary) {
        generationFailures += 1;
        await input.repository.releaseCandidateBrief(input.workspaceId, target.id);
        return null;
      }
      const contractIssues = candidateBriefContractIssues(summary.summary, events);
      if (!target.briefEvidenceFingerprint || contractIssues.length) {
        contractFailures += 1;
        console.warn("Candidate brief contract rejected model output", {
          issues: target.briefEvidenceFingerprint ? contractIssues : ["missing-fingerprint"],
        });
        await input.repository.releaseCandidateBrief(input.workspaceId, target.id);
        return null;
      }
      return {
        target,
        events,
        score,
        summary,
        embeddingText: buildCandidateEmbeddingText({
          person: target.person,
          events,
          summary: summary.summary,
        }),
      };
    } catch {
      await input.repository.releaseCandidateBrief(input.workspaceId, target.id);
      return null;
    }
  });
  const completed = prepared.filter((item): item is NonNullable<typeof item> => Boolean(item));
  const embeddings = await embedCandidateTexts(completed.map((item) => item.embeddingText)).catch(() =>
    completed.map(() => null),
  );
  const generatedAt = new Date().toISOString();
  const briefModel = process.env.AI_SUMMARY_MODEL || process.env.AI_MODEL || "openai/gpt-4o-mini";
  let persistenceFailures = 0;
  await mapLimit(completed, 3, async (item, index) => {
    try {
      await input.repository.updateCandidateIntelligence({
        workspaceId: input.workspaceId,
        candidateId: item.target.id,
        score: item.score,
        summary: item.summary,
        embedding: embeddings[index],
        embeddingModel: embeddings[index] ? DEFAULT_EMBEDDING_MODEL : null,
        persistSummary: true,
        briefEvidenceFingerprint: item.target.briefEvidenceFingerprint,
        briefGeneratedAt: generatedAt,
        briefModel,
        briefPromptVersion: CURRENT_CANDIDATE_BRIEF_POLICY,
      });
    } catch {
      persistenceFailures += 1;
      await input.repository.releaseCandidateBrief(input.workspaceId, item.target.id).catch(() => undefined);
    }
  });
  const persisted = completed.length - persistenceFailures;
  return {
    claimed: targets.length,
    completed: persisted,
    failed: targets.length - persisted,
    generationFailures,
    contractFailures,
    persistenceFailures,
  };
}

export async function runDiscoveryBatch(options: RunOptions): Promise<DiscoveryRunSummary> {
  const startedAt = new Date();
  const configuration = options.configuration ?? parseDiscoveryConfiguration();
  const registry = createConnectorRegistry();
  const allowedKinds = options.sourceKinds ? new Set(options.sourceKinds) : null;
  const runnable = [...registry.values()].filter(
    (connector) =>
      configuration.connectors[connector.kind]?.enabled &&
      (!allowedKinds || allowedKinds.has(connector.kind)),
  );
  const runId = await options.repository.startRun({
    workspaceId: options.workspaceId,
    sources: runnable.map((connector) => connector.kind),
    startedAt: startedAt.toISOString(),
  });
  const failures: DiscoveryRunSummary["connectorFailures"] = [];
  const seenRunEventKeys = new Set<string>();
  const createdCandidateIds = new Set<string>();
  const updatedCandidateIds = new Set<string>();
  const reviewedCandidateIds = new Set<string>();
  const enrichedCandidateIds = new Set<string>();
  let eventsObserved = 0;
  let eventsInserted = 0;

  const recordPersistence = (events: DiscoveryEvent[], persisted: PersistedEvents) => {
    eventsObserved += events.length;
    eventsInserted += persisted.eventsInserted;
    for (const candidateId of persisted.createdCandidateIds) {
      createdCandidateIds.add(candidateId);
      updatedCandidateIds.delete(candidateId);
    }
    for (const candidateId of persisted.updatedCandidateIds) {
      if (!createdCandidateIds.has(candidateId)) updatedCandidateIds.add(candidateId);
    }
    for (const candidateId of persisted.reviewedCandidateIds) {
      reviewedCandidateIds.add(candidateId);
    }
  };

  try {
    const connectorResults = await mapLimit(runnable, 3, async (connector) => {
      try {
        const result = await connector.discover({
          now: startedAt,
          settings: configuration.connectors[connector.kind]!,
          signal: options.signal,
        });
        return { connector, result };
      } catch (error) {
        failures.push({
          source: connector.kind,
          message: error instanceof Error ? error.message : "Unknown connector error",
        });
        return { connector, result: { events: [] } satisfies ConnectorRunResult };
      }
    });

    const eventLimit = Math.min(1_000, Math.max(1, options.boundedEventLimit ?? 400));
    const events = uniqueRunEvents(
      deduplicateEvents(connectorResults.flatMap((item) => item.result.events)).sort(
        (left, right) => eventPriority(right) - eventPriority(left),
      ),
      seenRunEventKeys,
      eventLimit,
    );
    const aiSummaryLimit = Math.min(
      100,
      Math.max(
        0,
        Number(options.aiEventSummaryLimit ?? process.env.AI_EVENT_SUMMARY_LIMIT ?? 30),
      ),
    );
    let remainingAiSummaries = aiSummaryLimit;
    const allocateAiSummaryKeys = (batch: DiscoveryEvent[]) => {
      const selected = batch.slice(0, remainingAiSummaries);
      remainingAiSummaries = Math.max(0, remainingAiSummaries - selected.length);
      return new Set(selected.map((event) => event.idempotencyKey));
    };
    const persisted = await persistObservedEvents({
      repository: options.repository,
      workspaceId: options.workspaceId,
      events,
      aiSummaryKeys: allocateAiSummaryKeys(events),
    });
    recordPersistence(events, persisted);

    for (const { connector, result } of connectorResults) {
      if (result.cursor) {
        await options.repository.saveConnectorCursor({
          workspaceId: options.workspaceId,
          source: connector.kind,
          cursor: result.cursor,
          completedAt: new Date().toISOString(),
        });
      }
    }
    const initialGraphEdges = connectorResults.flatMap((item) => item.result.edges ?? []);
    if (initialGraphEdges.length) {
      await options.repository.upsertGraphEdges({
        workspaceId: options.workspaceId,
        edges: initialGraphEdges,
      });
    }

    const requestedAutomaticReviewLimit = Number(
      options.intelligenceRefreshLimit ?? process.env.AUTOMATIC_REVIEW_LIMIT ?? 100,
    );
    const automaticReviewLimit = Number.isFinite(requestedAutomaticReviewLimit)
      ? Math.max(0, Math.floor(requestedAutomaticReviewLimit))
      : 100;
    const enrichmentTargets = await options.repository.listEnrichmentTargets(
      options.workspaceId,
      configuration.enrichTopCandidates,
    );
    const enrichment = await enrichPeople({
      people: enrichmentTargets.map((target) => target.person),
      evidenceEvents: enrichmentTargets.map((target) => target.events),
      researchPasses: enrichmentTargets.map((target) => target.researchPass ?? 0),
      connectors: registry,
      settings: configuration.connectors,
      now: startedAt,
      signal: options.signal,
    });
    const enrichedEvents = uniqueRunEvents(
      enrichment.results.flatMap((item) => item.events),
      seenRunEventKeys,
    );
    const enrichedPersisted = await persistObservedEvents({
      repository: options.repository,
      workspaceId: options.workspaceId,
      events: enrichedEvents,
      aiSummaryKeys: allocateAiSummaryKeys(enrichedEvents),
    });
    recordPersistence(enrichedEvents, enrichedPersisted);
    await mapLimit(enrichmentTargets, 3, async (target, index) => {
      await options.repository.recordEnrichmentAttempt({
        workspaceId: options.workspaceId,
        candidateId: target.id,
        attemptedAt: startedAt.toISOString(),
        eventCount: enrichment.results[index]?.events.length ?? 0,
        researchPass: target.researchPass,
        researchRevision: target.researchRevision,
      });
    });
    for (const candidateId of enrichedPersisted.affected.keys()) {
      enrichedCandidateIds.add(candidateId);
    }
    const enrichmentEdges = enrichment.results.flatMap((item) => item.edges);
    if (enrichmentEdges.length) {
      await options.repository.upsertGraphEdges({
        workspaceId: options.workspaceId,
        edges: enrichmentEdges,
      });
    }

    const graphExpansionEnabled = options.graphExpansion !== false;
    const requestedGraphSeedLimit = Number(process.env.GRAPH_SEED_LIMIT ?? 12);
    const graphSeedLimit = !graphExpansionEnabled
      ? 0
      : Number.isFinite(requestedGraphSeedLimit)
        ? Math.min(25, Math.max(0, Math.floor(requestedGraphSeedLimit)))
        : 12;
    const graphSeeds = graphSeedLimit
      ? await options.repository.listGraphExpansionSeeds(options.workspaceId, graphSeedLimit)
      : [];
    if (graphSeeds.length) {
      await options.repository.bindGraphExpansionSeeds(options.workspaceId, graphSeeds);
    }
    const requestedGraphEdgesPerSeed = Number(process.env.GRAPH_EDGE_LIMIT_PER_SEED ?? 60);
    const graphEdgesPerSeed = Number.isFinite(requestedGraphEdgesPerSeed)
      ? Math.min(100, Math.max(1, Math.floor(requestedGraphEdgesPerSeed)))
      : 60;
    let expandedGraphEdges = initialGraphEdges.slice(0, 0);
    if (configuration.graphDepth > 0 && graphSeeds.length) {
      const graph = await expandDiscoveryGraph({
        seeds: graphSeeds.map((target) => target.person),
        connectors: registry,
        settings: configuration.connectors,
        maxDepth: configuration.graphDepth,
        maxNodes: configuration.graphNodeLimit,
        maxEdgesPerSeed: graphEdgesPerSeed,
        now: startedAt,
        signal: options.signal,
      });
      expandedGraphEdges = graph.edges;
      if (graph.edges.length) {
        await options.repository.upsertGraphEdges({
          workspaceId: options.workspaceId,
          edges: graph.edges,
        });
      }
    }

    const graphCandidateLimit = Math.min(
      100,
      Math.max(0, Number(process.env.GRAPH_CANDIDATE_LIMIT ?? 50)),
    );
    const graphEvents = uniqueRunEvents(
      graphEdgesToCandidateEvents({
        edges: [...initialGraphEdges, ...enrichmentEdges, ...expandedGraphEdges],
        now: startedAt,
        maxCandidates: graphCandidateLimit,
      }),
      seenRunEventKeys,
    );
    const graphPersisted = await persistObservedEvents({
      repository: options.repository,
      workspaceId: options.workspaceId,
      events: graphEvents,
      aiSummaryKeys: allocateAiSummaryKeys(graphEvents),
    });
    recordPersistence(graphEvents, graphPersisted);

    const alreadyEnrichedCandidateIds = new Set(enrichmentTargets.map((target) => target.id));
    const graphEnrichmentLimit = graphExpansionEnabled
      ? Math.min(
          5,
          Math.max(0, Number(process.env.GRAPH_CANDIDATE_ENRICHMENT_LIMIT ?? 5)),
        )
      : 0;
    const graphPeople = [...graphPersisted.affected]
      .filter(([candidateId]) => !alreadyEnrichedCandidateIds.has(candidateId))
      .sort(
        ([, left], [, right]) =>
          Math.max(...right.events.map(eventPriority)) -
            Math.max(...left.events.map(eventPriority)) ||
          left.person.displayName.localeCompare(right.person.displayName),
      )
      .slice(0, graphEnrichmentLimit)
      .map(([, aggregate]) => aggregate.person);
    const graphEnrichment = await enrichPeople({
      people: graphPeople,
      connectors: registry,
      settings: configuration.connectors,
      now: startedAt,
      signal: options.signal,
    });
    const graphEnrichedEvents = uniqueRunEvents(
      graphEnrichment.results.flatMap((item) => item.events),
      seenRunEventKeys,
    );
    const graphEnrichedPersisted = await persistObservedEvents({
      repository: options.repository,
      workspaceId: options.workspaceId,
      events: graphEnrichedEvents,
      aiSummaryKeys: allocateAiSummaryKeys(graphEnrichedEvents),
    });
    recordPersistence(graphEnrichedEvents, graphEnrichedPersisted);
    for (const candidateId of graphEnrichedPersisted.affected.keys()) {
      enrichedCandidateIds.add(candidateId);
    }
    const graphEnrichmentEdges = graphEnrichment.results.flatMap((item) => item.edges);
    if (graphEnrichmentEdges.length) {
      await options.repository.upsertGraphEdges({
        workspaceId: options.workspaceId,
        edges: graphEnrichmentEdges,
      });
    }

    const affectedEvents = new Map<string, DiscoveryEvent[]>();
    const affectedPeople = new Map<string, PersonObservation>();
    for (const persistedBatch of [
      persisted,
      enrichedPersisted,
      graphPersisted,
      graphEnrichedPersisted,
    ]) {
      for (const [candidateId, aggregate] of persistedBatch.affected) {
        affectedPeople.set(candidateId, aggregate.person);
        affectedEvents.set(candidateId, [
          ...(affectedEvents.get(candidateId) ?? []),
          ...aggregate.events,
        ]);
      }
    }
    const requestedIntelligenceLimit = Number(
      options.intelligenceRefreshLimit ?? process.env.INTELLIGENCE_REFRESH_LIMIT ?? 30,
    );
    const configuredIntelligenceLimit = Number.isFinite(requestedIntelligenceLimit)
      ? Math.max(0, Math.floor(requestedIntelligenceLimit))
      : 30;
    const intelligenceLimit = Math.min(
      100,
      Math.max(
        configuredIntelligenceLimit,
        automaticReviewLimit,
      ),
    );
    const reviewTargets = intelligenceLimit > configuration.enrichTopCandidates
      ? await options.repository.listIntelligenceTargets(options.workspaceId, intelligenceLimit)
      : enrichmentTargets;
    const existingTargets = new Map(reviewTargets.map((target) => [target.id, target]));
    const graphCandidateIds = new Set(graphPersisted.affected.keys());
    const freshTargets = [...affectedEvents]
      .map(([candidateId, candidateEvents]) => {
        const existing = existingTargets.get(candidateId);
        return {
          ...(existing ?? {
            id: candidateId,
            person: affectedPeople.get(candidateId)!,
            events: candidateEvents,
          }),
          score: scoreCandidate({
            events: candidateEvents,
            weights: configuration.scoringWeights,
          }).total,
        };
      })
      .filter((target) => target.person)
      .sort(
        (left, right) =>
          Number(graphCandidateIds.has(right.id)) - Number(graphCandidateIds.has(left.id)) ||
          (right.score ?? 0) - (left.score ?? 0),
      );
    const targetMap = new Map<string, EnrichmentTarget>();
    for (const target of freshTargets) {
      if (targetMap.size >= intelligenceLimit) break;
      targetMap.set(target.id, target);
    }
    for (const target of reviewTargets) {
      if (targetMap.size >= intelligenceLimit) break;
      if (!targetMap.has(target.id)) targetMap.set(target.id, target);
    }
    await refreshIntelligence({
      repository: options.repository,
      workspaceId: options.workspaceId,
      targets: [...targetMap.values()].slice(0, intelligenceLimit),
      runEvents: affectedEvents,
      weights: configuration.scoringWeights,
    });

    const completedAt = new Date();
    const summary: DiscoveryRunSummary = {
      runId,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      connectorsRun: runnable.length,
      connectorFailures: failures,
      eventsObserved,
      eventsInserted,
      candidatesCreated: createdCandidateIds.size,
      candidatesUpdated: updatedCandidateIds.size,
      identitiesFlaggedForReview: reviewedCandidateIds.size,
      enrichedCandidates: enrichedCandidateIds.size,
    };
    await options.repository.finishRun({
      workspaceId: options.workspaceId,
      runId,
      status: failures.length ? "partial" : "succeeded",
      summary,
    });
    return summary;
  } catch (error) {
    const completedAt = new Date();
    const summary: DiscoveryRunSummary = {
      runId,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      connectorsRun: runnable.length,
      connectorFailures: [
        ...failures,
        { source: runnable[0]?.kind ?? "github", message: error instanceof Error ? error.message : "Pipeline failure" },
      ],
      eventsObserved,
      eventsInserted,
      candidatesCreated: createdCandidateIds.size,
      candidatesUpdated: updatedCandidateIds.size,
      identitiesFlaggedForReview: reviewedCandidateIds.size,
      enrichedCandidates: enrichedCandidateIds.size,
    };
    await options.repository.finishRun({
      workspaceId: options.workspaceId,
      runId,
      status: "failed",
      summary,
    });
    throw error;
  }
}
