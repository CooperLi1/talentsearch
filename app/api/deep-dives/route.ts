import {
  getDefaultConnectorSettings,
  parseDiscoveryConfiguration,
} from "@/lib/discovery/config";
import { createTalentRadarDiscoveryRepository } from "@/lib/discovery/adapters/talent-radar";
import { runDiscoveryBatch } from "@/lib/discovery/engine";

import {
  getWorkspaceId,
  readJson,
  withDashboard,
} from "../_lib/http";
import { deepDiveRunSchema } from "../_lib/schemas";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  return withDashboard(request, async () => {
    const input = await readJson(request, deepDiveRunSchema);
    const defaults = getDefaultConnectorSettings();
    const configuration = parseDiscoveryConfiguration({
      connectors: {
        ...Object.fromEntries(
          Object.keys(defaults).map((kind) => [kind, { enabled: false }]),
        ),
        "roster-page": {
          enabled: true,
          urls: [input.url],
          maxItems: Math.min(input.batchSize, input.maxPeople - input.offset),
          options: { offset: input.offset },
        },
      },
      // Import only roster evidence here. The always-on enrichment worker then
      // deep-researches every queued name under independent leases.
      enrichTopCandidates: 0,
      graphDepth: 0,
      graphNodeLimit: 0,
    });
    const summary = await runDiscoveryBatch({
      repository: createTalentRadarDiscoveryRepository(),
      workspaceId: getWorkspaceId(),
      configuration,
      sourceKinds: ["roster-page"],
      boundedEventLimit: input.batchSize,
      graphExpansion: false,
      intelligenceRefreshLimit: 0,
      aiEventSummaryLimit: 0,
      signal: request.signal,
    });
    const nextOffset = input.offset + summary.eventsObserved;

    return Response.json({
      ok: true,
      runId: summary.runId,
      namesFound: summary.eventsObserved,
      namesQueued: summary.candidatesCreated + summary.candidatesUpdated,
      candidatesCreated: summary.candidatesCreated,
      candidatesUpdated: summary.candidatesUpdated,
      warnings: summary.connectorFailures,
      complete:
        summary.eventsObserved < input.batchSize ||
        nextOffset >= input.maxPeople,
      nextOffset,
    });
  });
}
