import { createTalentRadarDiscoveryRepository, loadSourceConfiguration } from "@/lib/discovery/adapters/talent-radar";
import { runDiscoveryBatch } from "@/lib/discovery/engine";

import { getWorkspaceId, readJson, withDashboard } from "../../_lib/http";
import { discoveryRunSchema } from "../../_lib/schemas";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  return withDashboard(request, async () => {
    const input = await readJson(request, discoveryRunSchema);
    const workspaceId = getWorkspaceId();
    const summary = await runDiscoveryBatch({
      repository: createTalentRadarDiscoveryRepository(),
      workspaceId,
      configuration: await loadSourceConfiguration(workspaceId, false),
      sourceKinds: input.sourceKinds,
      boundedEventLimit: input.eventLimit,
      signal: request.signal,
    });
    return Response.json({
      ok: true,
      runId: summary.runId,
      discovered: summary.candidatesCreated,
      enriched: summary.enrichedCandidates,
    });
  });
}
