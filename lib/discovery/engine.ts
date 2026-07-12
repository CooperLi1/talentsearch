import {
  buildCandidateEmbeddingText,
  DEFAULT_EMBEDDING_MODEL,
  embedCandidateTexts,
} from "@/lib/ai/embeddings";
import {
  fallbackEventSummary,
  summarizeCandidate,
  summarizeEvent,
} from "@/lib/ai/summaries";

import { parseDiscoveryConfiguration, type DiscoveryConfiguration } from "./config";
import { createConnectorRegistry } from "./connectors";
import { mapLimit } from "./connectors/shared";
import { deduplicateEvents } from "./idempotency";
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
  signal?: AbortSignal;
};

function eventPriority(event: DiscoveryEvent) {
  const metrics = event.metrics ?? {};
  return (
    event.confidence * 10 +
    Math.log1p(metrics.momentum ?? 0) +
    Math.log1p(metrics.citations ?? 0) +
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

  for (const event of input.events) {
    const candidates = await input.repository.findIdentityCandidates(
      input.workspaceId,
      event.person,
    );
    const decision = resolveIdentity(event.person, candidates);
    const persisted = await input.repository.persistIdentityDecision({
      workspaceId: input.workspaceId,
      observation: event.person,
      decision,
    });
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
    const storedEvents = target.events.length
      ? target.events
      : await input.repository.listCandidateEvents(input.workspaceId, target.id);
    const events = deduplicateEvents([
      ...storedEvents,
      ...(input.runEvents?.get(target.id) ?? []),
    ]);
    const score = scoreCandidate({ events, weights: input.weights });
    const summary = await summarizeCandidate({
      person: target.person,
      events,
      score,
      previousSummary: target.previousSummary,
    });
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
  });
  const embeddings = await embedCandidateTexts(prepared.map((item) => item.embeddingText)).catch(() =>
    prepared.map(() => null),
  );
  await mapLimit(prepared, 3, async (item, index) => {
    await input.repository.updateCandidateIntelligence({
      workspaceId: input.workspaceId,
      candidateId: item.target.id,
      score: item.score,
      summary: item.summary,
      embedding: embeddings[index],
      embeddingModel: embeddings[index] ? DEFAULT_EMBEDDING_MODEL : null,
    });
  });
  return prepared.map((item) => ({ candidateId: item.target.id, score: item.score }));
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
      Math.max(0, Number(process.env.AI_EVENT_SUMMARY_LIMIT ?? 30)),
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

    const enrichmentTargets = await options.repository.listEnrichmentTargets(
      options.workspaceId,
      configuration.enrichTopCandidates,
    );
    const enrichment = await enrichPeople({
      people: enrichmentTargets.map((target) => target.person),
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

    let expandedGraphEdges = initialGraphEdges.slice(0, 0);
    if (configuration.graphDepth > 0 && enrichmentTargets.length) {
      const graph = await expandDiscoveryGraph({
        seeds: enrichmentTargets.map((target) => target.person),
        connectors: registry,
        settings: configuration.connectors,
        maxDepth: configuration.graphDepth,
        maxNodes: configuration.graphNodeLimit,
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
    const graphEnrichmentLimit = Math.min(
      5,
      Math.max(0, Number(process.env.GRAPH_CANDIDATE_ENRICHMENT_LIMIT ?? 5)),
    );
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
    const intelligenceLimit = Math.min(
      100,
      Math.max(
        configuration.enrichTopCandidates,
        Number(process.env.INTELLIGENCE_REFRESH_LIMIT ?? 30),
        affectedEvents.size,
      ),
    );
    const existingTargets = new Map(enrichmentTargets.map((target) => [target.id, target]));
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
    for (const target of enrichmentTargets) {
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
