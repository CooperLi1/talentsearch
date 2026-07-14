import { createClient } from "@supabase/supabase-js";

import type { Database } from "../lib/supabase/database.types";

type EventRow = {
  id: number;
  candidate_id: number;
  source_url: string;
};

type RepositoryResponse = {
  fork?: boolean;
  full_name?: string;
};

const apply = process.argv.includes("--apply");
const supabaseUrl = process.env.SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!supabaseUrl || !serviceRoleKey) throw new Error("Supabase admin environment is required");

const client = createClient<Database>(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
});

function repositoryPath(sourceUrl: string) {
  try {
    const url = new URL(sourceUrl);
    if (url.hostname.toLowerCase() !== "github.com") return null;
    const [owner, repo] = url.pathname.split("/").filter(Boolean);
    return owner && repo ? `${owner}/${repo.replace(/\.git$/i, "")}` : null;
  } catch {
    return null;
  }
}

async function mapLimit<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>) {
  const results: R[] = [];
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

async function main() {
  const { data, error } = await client
    .from("events")
    .select("id,candidate_id,source_url")
    .eq("source_label", "github")
    .in("event_type", ["project_created", "project_momentum", "open_source_contribution"])
    .limit(1_000);
  if (error) throw error;

  const events = (data ?? []) as EventRow[];
  const byRepository = new Map<string, EventRow[]>();
  for (const event of events) {
    const path = repositoryPath(event.source_url);
    if (!path) continue;
    byRepository.set(path, [...(byRepository.get(path) ?? []), event]);
  }

  const headers: HeadersInit = {
    accept: "application/vnd.github+json",
    "user-agent": "talent-research-fork-audit/1.0",
    "x-github-api-version": "2022-11-28",
    ...(process.env.GITHUB_TOKEN?.trim()
      ? { authorization: `Bearer ${process.env.GITHUB_TOKEN.trim()}` }
      : {}),
  };
  const repositoryResults = await mapLimit([...byRepository.keys()], 4, async (path) => {
    const response = await fetch(`https://api.github.com/repos/${path}`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 404) return { path, fork: false, unavailable: true };
    if (!response.ok) throw new Error(`GitHub returned ${response.status} for ${path}`);
    const repository = await response.json() as RepositoryResponse;
    return { path, fork: repository.fork === true, unavailable: false };
  });

  const forkEvents = repositoryResults
    .filter((repository) => repository.fork)
    .flatMap((repository) => byRepository.get(repository.path) ?? []);
  const affectedCandidates = [...new Set(forkEvents.map((event) => event.candidate_id))];

  if (apply && forkEvents.length) {
    const eventIds = forkEvents.map((event) => event.id);
    const evidenceDelete = await client.from("event_evidence").delete().in("event_id", eventIds);
    if (evidenceDelete.error) throw evidenceDelete.error;
    const eventDelete = await client.from("events").delete().in("id", eventIds);
    if (eventDelete.error) throw eventDelete.error;
    const invalidation = await client
      .from("candidates")
      .update({
        brief_claimed_until: null,
        brief_evidence_fingerprint: null,
        brief_prompt_version: null,
      })
      .in("id", affectedCandidates);
    if (invalidation.error) throw invalidation.error;
  }

  console.log(JSON.stringify({
    apply,
    repositoriesChecked: repositoryResults.length,
    unavailableRepositories: repositoryResults.filter((repository) => repository.unavailable).length,
    forkEvents: forkEvents.length,
    affectedCandidates: affectedCandidates.length,
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "GitHub fork audit failed");
  process.exitCode = 1;
});
