import { runEnrichmentShard } from "@/lib/discovery/enrichment-runner";

import { apiErrorResponse, assertCronRequest, getWorkspaceId } from "../../_lib/http";

export const runtime = "nodejs";
export const maxDuration = 300;

// Leave 90 seconds for persistence and run-ledger completion before Vercel's
// 300-second hard stop.
const ENRICHMENT_DEADLINE_MS = 210_000;

export async function GET(request: Request) {
  try {
    assertCronRequest(request);
    if (process.env.EXTERNAL_WORKER_ACTIVE === "true") {
      return Response.json({ ok: true, skipped: "external-worker-active" });
    }
    const workspaceId = getWorkspaceId();
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(ENRICHMENT_DEADLINE_MS),
    ]);
    const summary = await runEnrichmentShard({
      workspaceId,
      candidateLimit: 1,
      connectorLimit: 5,
      signal,
    });
    return Response.json({ ok: true, summary });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
