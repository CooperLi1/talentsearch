import { pathToFileURL } from "node:url";

import {
  createTalentRadarDiscoveryRepository,
  loadSourceConfiguration,
} from "@/lib/discovery/adapters/talent-radar";
import { runEnrichmentShard } from "@/lib/discovery/enrichment-runner";
import { runCandidateBriefBatch } from "@/lib/discovery/engine";
import { hasSupabaseAdminEnv } from "@/lib/supabase/admin";
import {
  resolveWorkerSettings,
  type EnrichmentWorkerSettings,
} from "@/lib/workers/enrichment-settings";

function sleep(ms: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timeout = setTimeout(done, ms);
    function done() {
      clearTimeout(timeout);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function log(event: string, details: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...details }));
}

async function enrichmentLane(input: {
  lane: number;
  settings: EnrichmentWorkerSettings;
  stopSignal: AbortSignal;
  once: boolean;
}) {
  let consecutiveFailures = 0;
  do {
    const startedAt = Date.now();
    try {
      const summary = await runEnrichmentShard({
        workspaceId: input.settings.workspaceId,
        candidateLimit: 1,
        connectorLimit: input.settings.connectorLimit,
        signal: AbortSignal.timeout(input.settings.timeoutMs),
      });
      consecutiveFailures = 0;
      log("enrichment.completed", {
        lane: input.lane,
        runId: summary.runId,
        claimed: summary.enrichmentCandidatesClaimed,
        eventsObserved: summary.eventsObserved,
        eventsInserted: summary.eventsInserted,
        durationMs: Date.now() - startedAt,
        failures: summary.connectorFailures.length,
      });
      if (input.once) return;
      await sleep(
        summary.enrichmentCandidatesClaimed ? input.settings.pollMs : input.settings.emptyPollMs,
        input.stopSignal,
      );
    } catch (error) {
      if (input.stopSignal.aborted) return;
      consecutiveFailures += 1;
      const delayMs = Math.min(
        input.settings.errorBackoffMs * 2 ** Math.min(consecutiveFailures - 1, 5),
        300_000,
      );
      console.error(JSON.stringify({
        at: new Date().toISOString(),
        event: "enrichment.failed",
        lane: input.lane,
        durationMs: Date.now() - startedAt,
        retryInMs: input.once ? null : delayMs,
        error: message(error),
      }));
      if (input.once) throw error;
      await sleep(delayMs, input.stopSignal);
    }
  } while (!input.stopSignal.aborted);
}

async function briefLane(input: {
  settings: EnrichmentWorkerSettings;
  stopSignal: AbortSignal;
  once: boolean;
}) {
  if (!input.settings.briefEnabled) {
    log("briefs.disabled");
    return;
  }
  if (
    !process.env.OPENAI_API_KEY?.trim() &&
    !process.env.AI_GATEWAY_API_KEY?.trim() &&
    !process.env.VERCEL_OIDC_TOKEN?.trim()
  ) {
    log("briefs.disabled", { reason: "No model credential is configured" });
    return;
  }

  do {
    const startedAt = Date.now();
    try {
      const configuration = await loadSourceConfiguration(input.settings.workspaceId, false);
      const result = await runCandidateBriefBatch({
        repository: createTalentRadarDiscoveryRepository(),
        workspaceId: input.settings.workspaceId,
        limit: input.settings.briefLimit,
        weights: configuration.scoringWeights,
      });
      log("briefs.completed", {
        ...result,
        durationMs: Date.now() - startedAt,
      });
      if (input.once) return;
    } catch (error) {
      if (input.stopSignal.aborted) return;
      console.error(JSON.stringify({
        at: new Date().toISOString(),
        event: "briefs.failed",
        durationMs: Date.now() - startedAt,
        error: message(error),
      }));
      if (input.once) throw error;
    }
    await sleep(input.settings.briefIntervalMs, input.stopSignal);
  } while (!input.stopSignal.aborted);
}

async function main() {
  if (!hasSupabaseAdminEnv()) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }
  const settings = resolveWorkerSettings(process.env);
  const once = process.argv.includes("--once");
  const stop = new AbortController();
  let stopping = false;
  const requestStop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log("worker.stopping", { signal });
    // Active passes finish under their candidate timeout; only sleeps stop now.
    stop.abort();
  };
  process.once("SIGTERM", () => requestStop("SIGTERM"));
  process.once("SIGINT", () => requestStop("SIGINT"));

  log("worker.started", {
    once,
    workspaceId: settings.workspaceId,
    concurrency: settings.concurrency,
    connectorLimit: settings.connectorLimit,
    briefs: settings.briefEnabled,
  });

  await Promise.all([
    ...Array.from({ length: settings.concurrency }, (_, index) =>
      enrichmentLane({ lane: index + 1, settings, stopSignal: stop.signal, once }),
    ),
    briefLane({ settings, stopSignal: stop.signal, once }),
  ]);
  log("worker.stopped");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({
      at: new Date().toISOString(),
      event: "worker.fatal",
      error: message(error),
    }));
    process.exitCode = 1;
  });
}
