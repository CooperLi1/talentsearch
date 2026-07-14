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
    const summary = await runDiscoveryBatch({
      repository: createTalentRadarDiscoveryRepository(),
      workspaceId,
      configuration: await loadSourceConfiguration(workspaceId, false),
      // Discovery is intentionally empty. This worker rotates through existing
      // candidates and follows provider profiles, owned sites, and public search.
      sourceKinds: [],
      boundedEventLimit: 1,
      signal: request.signal,
    });
    return Response.json({ ok: true, summary });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
