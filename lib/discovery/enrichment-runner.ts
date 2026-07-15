import "server-only";

import {
  createTalentRadarDiscoveryRepository,
  loadSourceConfiguration,
} from "@/lib/discovery/adapters/talent-radar";
import { runDiscoveryBatch } from "@/lib/discovery/engine";

const DEFAULT_CANDIDATE_LIMIT = 1;
const DEFAULT_CONNECTOR_LIMIT = 5;

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(value!)));
}

export async function runEnrichmentShard(input: {
  workspaceId: string;
  candidateLimit?: number;
  connectorLimit?: number;
  signal?: AbortSignal;
}) {
  const configuration = await loadSourceConfiguration(input.workspaceId, false);
  const brave = configuration.connectors["brave-enrichment"];
  const candidateLimit = boundedInteger(
    input.candidateLimit,
    DEFAULT_CANDIDATE_LIMIT,
    1,
    5,
  );
  const connectorLimit = boundedInteger(
    input.connectorLimit,
    DEFAULT_CONNECTOR_LIMIT,
    1,
    12,
  );

  return runDiscoveryBatch({
    repository: createTalentRadarDiscoveryRepository(),
    workspaceId: input.workspaceId,
    configuration: {
      ...configuration,
      // One claim per shard gives each candidate an independent lease and
      // checkpoint. External workers gain throughput through parallel shards.
      enrichTopCandidates: Math.min(candidateLimit, configuration.enrichTopCandidates),
      connectors: {
        ...configuration.connectors,
        "brave-enrichment": brave
          ? {
              ...brave,
              options: {
                ...brave.options,
                maxQueries: Math.min(3, Number(brave.options?.maxQueries ?? 3)),
                maxResults: Math.min(5, Number(brave.options?.maxResults ?? 5)),
              },
            }
          : brave,
      },
    },
    sourceKinds: [],
    boundedEventLimit: 1,
    graphExpansion: false,
    aiEventSummaryLimit: 0,
    intelligenceRefreshLimit: 0,
    maxEnrichmentConnectorsPerPerson: connectorLimit,
    signal: input.signal,
  });
}
