export type RateLimitPolicy = {
  bucket: string;
  limit: number;
  windowSeconds: number;
};

export type RateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: string;
  retryAfterSeconds: number;
};

type LocalWindow = { count: number; resetAt: number };

const localWindows = new Map<string, LocalWindow>();

export function consumeLocalRateLimit(
  key: string,
  policy: RateLimitPolicy,
  now = Date.now(),
): RateLimitResult {
  const windowMilliseconds = Math.max(1, policy.windowSeconds) * 1_000;
  const windowStart = Math.floor(now / windowMilliseconds) * windowMilliseconds;
  const resetAt = windowStart + windowMilliseconds;
  const storageKey = `${policy.bucket}:${key}:${windowStart}`;
  const current = localWindows.get(storageKey);
  const count = (current?.count ?? 0) + 1;
  localWindows.set(storageKey, { count, resetAt });

  if (localWindows.size > 5_000) {
    for (const [candidateKey, window] of localWindows) {
      if (window.resetAt <= now) localWindows.delete(candidateKey);
    }
  }

  return {
    allowed: count <= policy.limit,
    limit: policy.limit,
    remaining: Math.max(0, policy.limit - count),
    resetAt: new Date(resetAt).toISOString(),
    retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1_000)),
  };
}
