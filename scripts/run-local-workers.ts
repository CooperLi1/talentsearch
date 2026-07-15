const DEFAULT_ORIGIN = "http://localhost:3000";
const REQUEST_TIMEOUT_MS = 4 * 60 * 1_000 + 45_000;

type WorkerJob = {
  name: string;
  path: string;
  intervalMs: number;
  initialDelayMs: number;
  cronSchedule?: string;
};

const jobs: WorkerJob[] = [
  {
    name: "weekly digest",
    path: "/api/cron/weekly-digest",
    intervalMs: 15 * 60 * 1_000,
    initialDelayMs: 15_000,
    // The production cron sends this header. Matching it locally gives the
    // digest route the same late-invocation tolerance as Vercel Hobby.
    cronSchedule: "local-worker",
  },
  {
    name: "enrichment",
    path: "/api/cron/enrichment",
    intervalMs: 5 * 60 * 1_000,
    initialDelayMs: 0,
  },
  {
    name: "candidate briefs",
    path: "/api/cron/briefs",
    intervalMs: 10 * 60 * 1_000,
    initialDelayMs: 60_000,
  },
  {
    name: "discovery",
    path: "/api/cron/discovery",
    intervalMs: 24 * 60 * 60 * 1_000,
    initialDelayMs: 3 * 60 * 1_000,
  },
];

function workerOrigin() {
  const configured = process.env.WORKER_APP_URL || process.env.NEXT_PUBLIC_APP_URL || DEFAULT_ORIGIN;
  const origin = new URL(configured).origin;
  const hostname = new URL(origin).hostname;
  const isLocal = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  if (!isLocal && process.env.ALLOW_REMOTE_LOCAL_WORKERS !== "1") {
    throw new Error(
      "The local worker runner only calls localhost. Set ALLOW_REMOTE_LOCAL_WORKERS=1 to target a remote deployment explicitly.",
    );
  }
  return origin;
}

async function runJob(job: WorkerJob, origin: string, secret: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const response = await fetch(new URL(job.path, origin), {
      headers: {
        authorization: `Bearer ${secret}`,
        ...(job.cronSchedule
          ? { "x-vercel-cron-schedule": job.cronSchedule }
          : {}),
      },
      signal: controller.signal,
    });
    const body = (await response.text()).slice(0, 1_500);
    const durationSeconds = ((Date.now() - startedAt) / 1_000).toFixed(1);
    if (!response.ok) {
      throw new Error(`${job.name} returned ${response.status} after ${durationSeconds}s: ${body}`);
    }
    console.log(`[workers] ${job.name} completed in ${durationSeconds}s ${body}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) throw new Error("CRON_SECRET is required.");
  const origin = workerOrigin();
  const once = process.argv.includes("--once");
  const requestedJob = process.argv.find((argument) => argument.startsWith("--job="))?.slice(6);
  const selectedJobs = requestedJob
    ? jobs.filter((job) => job.name === requestedJob || job.path.endsWith(`/${requestedJob}`))
    : jobs;
  if (!selectedJobs.length) {
    throw new Error(`Unknown worker job: ${requestedJob}`);
  }

  if (once) {
    for (const job of selectedJobs) await runJob(job, origin, secret);
    return;
  }

  console.log(
    `[workers] running against ${origin}; digest every 15 minutes, enrichment every 5 minutes, briefs every 10 minutes, discovery daily`,
  );
  const running = new Set<string>();
  const schedule = (job: WorkerJob) => {
    const tick = async () => {
      if (running.has(job.name)) {
        console.warn(`[workers] skipped overlapping ${job.name} invocation`);
        return;
      }
      running.add(job.name);
      try {
        await runJob(job, origin, secret);
      } catch (error) {
        console.error(`[workers] ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        running.delete(job.name);
      }
    };
    setTimeout(() => {
      void tick();
      setInterval(() => void tick(), job.intervalMs);
    }, job.initialDelayMs);
  };

  selectedJobs.forEach(schedule);
}

main().catch((error) => {
  console.error(`[workers] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
