import { createTalentRadarDiscoveryRepository, loadSourceConfiguration } from "@/lib/discovery/adapters/talent-radar";
import { runCandidateBriefBatch } from "@/lib/discovery/engine";

import { apiErrorResponse, assertCronRequest, getWorkspaceId } from "../../_lib/http";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: Request) {
  try {
    assertCronRequest(request);
    const workspaceId = getWorkspaceId();
    const configuration = await loadSourceConfiguration(workspaceId, false);
    const requestedLimit = Number(
      process.env.CANDIDATE_BRIEF_BATCH_LIMIT ??
        process.env.AI_CANDIDATE_SUMMARY_LIMIT ??
        12,
    );
    const result = await runCandidateBriefBatch({
      repository: createTalentRadarDiscoveryRepository(),
      workspaceId,
      limit: Number.isFinite(requestedLimit) ? requestedLimit : 12,
      weights: configuration.scoringWeights,
    });
    return Response.json({ ok: true, ...result });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
