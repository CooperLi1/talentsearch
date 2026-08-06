import { consumeLocalRateLimit, type RateLimitResult } from "@/lib/security/rate-limit-window";

import { stableHash } from "./idempotency";

export type MeteredProvider = "brave-search" | "people-data-labs";

const DAILY_WINDOW_SECONDS = 24 * 60 * 60;
const PROVIDER_LIMITS: Record<
  MeteredProvider,
  { env: "BRAVE_DAILY_REQUEST_LIMIT" | "PDL_DAILY_REQUEST_LIMIT"; fallback: number }
> = {
  "brave-search": { env: "BRAVE_DAILY_REQUEST_LIMIT", fallback: 48 },
  "people-data-labs": { env: "PDL_DAILY_REQUEST_LIMIT", fallback: 6 },
};

function boundedInteger(value: string | undefined, fallback: number, maximum: number) {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(0, Math.floor(parsed)));
}

export function providerDailyRequestLimit(provider: MeteredProvider) {
  const policy = PROVIDER_LIMITS[provider];
  return boundedInteger(process.env[policy.env], policy.fallback, 10_000);
}

function parseDatabaseResult(value: unknown): RateLimitResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const resetAt = String(record.resetAt ?? "");
  const limit = Number(record.limit);
  const remaining = Number(record.remaining);
  const retryAfterSeconds = Number(record.retryAfterSeconds);
  if (
    typeof record.allowed !== "boolean" ||
    !Number.isFinite(limit) ||
    !Number.isFinite(remaining) ||
    !Number.isFinite(retryAfterSeconds) ||
    !Number.isFinite(Date.parse(resetAt))
  ) return null;
  return {
    allowed: record.allowed,
    limit,
    remaining,
    resetAt,
    retryAfterSeconds,
  };
}

/**
 * Reserves one provider request from a project-wide daily allowance. The local
 * counter provides protection during a database incident; the existing atomic
 * Supabase RPC coordinates the budget across web and worker instances.
 */
export async function consumeProviderDailyBudget(
  provider: MeteredProvider,
): Promise<RateLimitResult> {
  const limit = providerDailyRequestLimit(provider);
  if (limit === 0) {
    return {
      allowed: false,
      limit: 0,
      remaining: 0,
      resetAt: new Date(Date.now() + DAILY_WINDOW_SECONDS * 1_000).toISOString(),
      retryAfterSeconds: DAILY_WINDOW_SECONDS,
    };
  }

  const bucket = `provider-budget:${provider}:daily`;
  const key = stableHash("provider-budget-v1", provider, "global");
  const local = consumeLocalRateLimit(key, {
    bucket,
    limit,
    windowSeconds: DAILY_WINDOW_SECONDS,
  });
  if (!local.allowed) return local;

  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl?.trim() || !process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) return local;

  try {
    // Keep the server-only admin client out of connector unit-test imports. In
    // production these connectors run only in server/worker entry points.
    const { getAdminSupabaseClient } = await import("@/lib/supabase/admin");
    const { data, error } = await getAdminSupabaseClient().rpc(
      "consume_api_rate_limit",
      {
        p_bucket: bucket,
        p_key_hash: key,
        p_limit: limit,
        p_window_seconds: DAILY_WINDOW_SECONDS,
      },
    );
    const parsed = !error ? parseDatabaseResult(data) : null;
    if (parsed) return parsed;
  } catch {
    // The per-instance allowance above remains active during a DB incident.
  }
  return local;
}
