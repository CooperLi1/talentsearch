export type WorkerEnvironment = Readonly<Record<string, string | undefined>>;

export type EnrichmentWorkerSettings = {
  workspaceId: string;
  concurrency: number;
  connectorLimit: number;
  pollMs: number;
  emptyPollMs: number;
  timeoutMs: number;
  errorBackoffMs: number;
  briefEnabled: boolean;
  briefIntervalMs: number;
  briefLimit: number;
};

function integerSetting(
  environment: WorkerEnvironment,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const parsed = Number(environment[key] ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(parsed)));
}

export function resolveWorkerSettings(
  environment: WorkerEnvironment,
): EnrichmentWorkerSettings {
  const workspaceId = (
    environment.UNFOUND_WORKSPACE_ID?.trim() ||
    environment.TALENT_RADAR_WORKSPACE_ID?.trim() ||
    environment.TALENT_WORKSPACE_ID?.trim() ||
    "1"
  );
  const parsedWorkspaceId = Number(workspaceId);
  if (!Number.isSafeInteger(parsedWorkspaceId) || parsedWorkspaceId <= 0) {
    throw new Error("Worker workspace id must be a positive integer");
  }

  return {
    workspaceId,
    concurrency: integerSetting(environment, "WORKER_ENRICHMENT_CONCURRENCY", 2, 1, 8),
    connectorLimit: integerSetting(environment, "WORKER_CONNECTORS_PER_PASS", 8, 1, 12),
    pollMs: integerSetting(environment, "WORKER_POLL_MS", 5_000, 1_000, 300_000),
    emptyPollMs: integerSetting(environment, "WORKER_EMPTY_POLL_MS", 60_000, 5_000, 900_000),
    // Claims currently last six minutes. End the pass early enough to persist
    // completion before another worker can reclaim the same candidate.
    timeoutMs: integerSetting(environment, "WORKER_CANDIDATE_TIMEOUT_MS", 240_000, 30_000, 300_000),
    errorBackoffMs: integerSetting(environment, "WORKER_ERROR_BACKOFF_MS", 15_000, 1_000, 300_000),
    briefEnabled: environment.WORKER_ENABLE_BRIEFS !== "false",
    briefIntervalMs: integerSetting(environment, "WORKER_BRIEF_INTERVAL_MS", 60_000, 15_000, 900_000),
    briefLimit: integerSetting(environment, "WORKER_BRIEF_BATCH_LIMIT", 6, 1, 12),
  };
}
