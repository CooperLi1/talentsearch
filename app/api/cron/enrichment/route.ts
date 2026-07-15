import {
  createTalentRadarDiscoveryRepository,
  loadSourceConfiguration,
} from "@/lib/discovery/adapters/talent-radar";
import { runDiscoveryBatch } from "@/lib/discovery/engine";

import { apiErrorResponse, assertCronRequest, getWorkspaceId } from "../../_lib/http";

export const runtime = "nodejs";
export const maxDuration = 300;

// Leave 90 seconds for persistence and run-ledger completion before Vercel's
// 300-second hard stop.
const ENRICHMENT_DEADLINE_MS = 210_000;

export async function GET(request: Request) {
  try {
    assertCronRequest(request);
    const workspaceId = getWorkspaceId();
    const configuration = await loadSourceConfiguration(workspaceId, false);
    const brave = configuration.connectors["brave-enrichment"];
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(ENRICHMENT_DEADLINE_MS),
    ]);
    const summary = await runDiscoveryBatch({
      repository: createTalentRadarDiscoveryRepository(),
      workspaceId,
      configuration: {
        ...configuration,
        // One durable claim per shard means a slow profile cannot erase the
        // completed work for two others when the function reaches its limit.
        enrichTopCandidates: Math.min(1, configuration.enrichTopCandidates),
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
      // Discovery is intentionally empty. This worker rotates through existing
      // candidates and follows provider profiles, owned sites, and public search.
      sourceKinds: [],
      boundedEventLimit: 1,
      // Graph expansion has its own daily discovery budget. Repeating it in all
      // 48 research shards doubles the network work and exhausts the function.
      graphExpansion: false,
      // Event prose and candidate briefs have separate workers. Keeping them
      // out of enrichment leaves the network worker enough time to checkpoint.
      aiEventSummaryLimit: 0,
      intelligenceRefreshLimit: 0,
      maxEnrichmentConnectorsPerPerson: 5,
      signal,
    });
    return Response.json({ ok: true, summary });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
