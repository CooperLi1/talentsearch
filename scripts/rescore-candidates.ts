import { createClient } from "@supabase/supabase-js";

import { evidencePublisherCount } from "../lib/discovery/evidence-publishers";
import { scoreCandidate } from "../lib/discovery/scoring";
import type { DiscoveryEvent, ScoringWeights } from "../lib/discovery/types";

const workspaceId = process.env.UNFOUND_WORKSPACE_ID?.trim() || "1";
const candidateIds = [...new Set(
  (process.env.CANDIDATE_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => /^\d+$/.test(value)),
)].slice(0, 100);

if (!candidateIds.length) {
  throw new Error("CANDIDATE_IDS must contain one or more comma-separated numeric IDs");
}

async function main() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRole) throw new Error("Supabase server credentials are required");
  const client = createClient(url, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const criterion = await client
    .from("criterion_profiles")
    .select("signal_weights")
    .eq("workspace_id", Number(workspaceId))
    .eq("status", "active")
    .maybeSingle();
  if (criterion.error) throw criterion.error;
  const aliases: Record<string, keyof ScoringWeights> = {
    originality: "projectOriginality",
    technical_complexity: "technicalComplexity",
    velocity: "trajectoryVelocity",
    network: "networkProximity",
    achievement: "achievementQuality",
    diversity: "evidenceDiversity",
    earlyness: "earlyness",
  };
  const rawWeights = criterion.data?.signal_weights as { signals?: Array<{
    key: string;
    weight: number;
    enabled: boolean;
  }> } | null;
  const weights = rawWeights?.signals
    ? Object.fromEntries(rawWeights.signals.map((signal) => [
        aliases[signal.key] ?? signal.key,
        signal.enabled ? Number(signal.weight) : 0,
      ])) as ScoringWeights
    : undefined;

  for (const candidateId of candidateIds) {
    const result = await client
      .from("events")
      .select("*")
      .eq("workspace_id", Number(workspaceId))
      .eq("candidate_id", Number(candidateId));
    if (result.error) throw result.error;
    const events = (result.data ?? []).map((row): DiscoveryEvent => {
      const raw = row.raw_payload && typeof row.raw_payload === "object"
        ? row.raw_payload as Record<string, unknown>
        : {};
      return {
        idempotencyKey: String(row.content_hash),
        source: String(row.source_label).toLowerCase().replaceAll("_", "-") as DiscoveryEvent["source"],
        sourceExternalId: String(row.external_id ?? row.id),
        type: row.event_type as DiscoveryEvent["type"],
        title: String(row.title),
        description: String(row.evidence_excerpt || row.summary_md || ""),
        occurredAt: String(row.occurred_at || row.discovered_at),
        discoveredAt: String(row.discovered_at),
        sourceUrl: String(row.source_url),
        evidence: [{ label: String(row.source_label), url: String(row.source_url) }],
        person: { displayName: "candidate", identities: [], sourceUrl: String(row.source_url) },
        metrics: raw.metrics && typeof raw.metrics === "object"
          ? raw.metrics as Record<string, number>
          : undefined,
        tags: Array.isArray(raw.tags) ? raw.tags.map(String) : undefined,
        raw,
        confidence: Number(row.confidence),
      };
    });
    if (!events.length) {
      console.warn(`[rescore] candidate ${candidateId} has no events; skipped`);
      continue;
    }
    const score = scoreCandidate({ events, weights });
    const sourceCount = evidencePublisherCount(events);
    const update = await client
      .from("candidates")
      .update({
        score: score.total,
        confidence: Math.max(0, 1 - score.confidencePenalty),
        score_components: score.features,
        source_count: sourceCount,
        last_seen_at: new Date().toISOString(),
      })
      .eq("workspace_id", Number(workspaceId))
      .eq("id", Number(candidateId));
    if (update.error) throw update.error;
    console.log(
      `[rescore] candidate ${candidateId}: score ${score.total.toFixed(1)}, ${sourceCount} source(s)`,
    );
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error
    ? error.message
    : error && typeof error === "object" && "message" in error
      ? String(error.message)
      : "Candidate rescoring failed";
  console.error(message);
  process.exitCode = 1;
});
