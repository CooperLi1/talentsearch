import {
  createTalentRadarDiscoveryRepository,
  loadSourceConfiguration,
} from "@/lib/discovery/adapters/talent-radar";
import { runDiscoveryBatch } from "@/lib/discovery/engine";

import { apiErrorResponse, assertCronRequest, getWorkspaceId } from "../../_lib/http";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: Request) {
  try {
    assertCronRequest(request);
    const workspaceId = getWorkspaceId();
    const configuration = await loadSourceConfiguration(workspaceId, false);
    const brave = configuration.connectors["brave-enrichment"];
    const summary = await runDiscoveryBatch({
      repository: createTalentRadarDiscoveryRepository(),
      workspaceId,
      configuration: {
        ...configuration,
        enrichTopCandidates: Math.min(3, configuration.enrichTopCandidates),
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
      intelligenceRefreshLimit: 20,
      signal: request.signal,
    });
    return Response.json({ ok: true, summary });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
