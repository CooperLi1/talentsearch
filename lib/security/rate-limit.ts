import "server-only";

import { createHmac } from "node:crypto";

import { getAdminSupabaseClient, hasSupabaseAdminEnv } from "@/lib/supabase/admin";
import {
  consumeLocalRateLimit,
  type RateLimitPolicy,
  type RateLimitResult,
} from "./rate-limit-window";

export type { RateLimitPolicy, RateLimitResult } from "./rate-limit-window";

export class RateLimitExceededError extends Error {
  constructor(
    readonly result: RateLimitResult,
  ) {
    super("Too many requests. Try again shortly.");
    this.name = "RateLimitExceededError";
  }
}

function clientAddress(request: Request) {
  return (
    request.headers.get("x-real-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

function keySecret() {
  return (
    process.env.RATE_LIMIT_HASH_SECRET?.trim() ||
    process.env.SESSION_SECRET?.trim() ||
    process.env.DASHBOARD_SESSION_SECRET?.trim() ||
    process.env.CRON_SECRET?.trim() ||
    "unfound-local-rate-limit"
  );
}

function requestKey(request: Request) {
  return createHmac("sha256", keySecret())
    .update(clientAddress(request))
    .digest("hex");
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

export async function consumeRateLimit(
  request: Request,
  policy: RateLimitPolicy,
): Promise<RateLimitResult> {
  const key = requestKey(request);
  if (hasSupabaseAdminEnv()) {
    try {
      const { data, error } = await getAdminSupabaseClient().rpc(
        "consume_api_rate_limit",
        {
          p_bucket: policy.bucket,
          p_key_hash: key,
          p_limit: policy.limit,
          p_window_seconds: policy.windowSeconds,
        },
      );
      const parsed = !error ? parseDatabaseResult(data) : null;
      if (parsed) return parsed;
    } catch {
      // During local setup or a database incident, retain per-instance protection.
    }
  }
  return consumeLocalRateLimit(key, policy);
}

export function dashboardRateLimitPolicy(request: Request): RateLimitPolicy {
  const { pathname } = new URL(request.url);
  if (pathname === "/api/discovery/run") {
    return { bucket: "dashboard:discovery", limit: 2, windowSeconds: 10 * 60 };
  }
  if (pathname === "/api/settings/suggest") {
    return { bucket: "dashboard:criteria-suggest", limit: 6, windowSeconds: 10 * 60 };
  }
  if (pathname === "/api/search") {
    return { bucket: "dashboard:search", limit: 30, windowSeconds: 60 };
  }
  if (pathname === "/api/feedback") {
    return { bucket: "dashboard:feedback", limit: 80, windowSeconds: 60 };
  }
  const mutating = ["POST", "PUT", "PATCH", "DELETE"].includes(request.method);
  return mutating
    ? { bucket: `dashboard:mutation:${pathname}`, limit: 40, windowSeconds: 60 }
    : { bucket: `dashboard:read:${pathname}`, limit: 120, windowSeconds: 60 };
}
