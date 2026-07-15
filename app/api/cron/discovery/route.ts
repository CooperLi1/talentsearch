import { createTalentRadarDiscoveryRepository, loadSourceConfiguration } from "@/lib/discovery/adapters/talent-radar";
import { runDiscoveryBatch } from "@/lib/discovery/engine";

import { apiErrorResponse, assertCronRequest, getWorkspaceId } from "../../_lib/http";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: Request) {
  try {
    assertCronRequest(request);
    const workspaceId = getWorkspaceId();
    const configuration = await loadSourceConfiguration(workspaceId, true);
    const summary = await runDiscoveryBatch({
      repository: createTalentRadarDiscoveryRepository(),
      workspaceId,
      // Discovery only locates and persists fresh public evidence. Research,
      // graph expansion, and model briefing have their own frequent workers.
      configuration: { ...configuration, enrichTopCandidates: 0 },
      boundedEventLimit: 80,
      graphExpansion: false,
      intelligenceRefreshLimit: 20,
      aiEventSummaryLimit: 0,
      signal: request.signal,
    });
    return Response.json({ ok: true, summary });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
