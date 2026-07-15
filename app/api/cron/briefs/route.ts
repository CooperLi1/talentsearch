import { createTalentRadarDiscoveryRepository, loadSourceConfiguration } from "@/lib/discovery/adapters/talent-radar";
import { runCandidateBriefBatch } from "@/lib/discovery/engine";

import { apiErrorResponse, assertCronRequest, getWorkspaceId } from "../../_lib/http";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: Request) {
  try {
    assertCronRequest(request);
    if (process.env.EXTERNAL_WORKER_ACTIVE === "true") {
      return Response.json({ ok: true, skipped: "external-worker-active" });
    }
    const workspaceId = getWorkspaceId();
    const configuration = await loadSourceConfiguration(workspaceId, false);
    const requestedLimit = Number(
      process.env.CANDIDATE_BRIEF_BATCH_LIMIT ??
        process.env.AI_CANDIDATE_SUMMARY_LIMIT ??
        6,
    );
    // Frequent cron shards provide higher completed throughput than one large
    // request that risks losing every in-flight generation at the function cap.
    const boundedLimit = Number.isFinite(requestedLimit)
      ? Math.min(6, Math.max(1, Math.floor(requestedLimit)))
      : 6;
    const result = await runCandidateBriefBatch({
      repository: createTalentRadarDiscoveryRepository(),
      workspaceId,
      limit: boundedLimit,
      weights: configuration.scoringWeights,
    });
    return Response.json({ ok: true, ...result });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
