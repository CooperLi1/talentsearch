type ErrorRecord = {
  name?: unknown;
  statusCode?: unknown;
  code?: unknown;
  responseBody?: unknown;
  cause?: unknown;
  errors?: unknown;
};

export type ModelCallFailure = {
  name: string;
  statusCode: number | null;
  code: string | null;
};

function record(value: unknown): ErrorRecord | null {
  return value !== null && typeof value === "object"
    ? (value as ErrorRecord)
    : null;
}

function responseCode(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value) as {
      error?: { code?: unknown; type?: unknown };
    };
    const code = parsed.error?.code ?? parsed.error?.type;
    return typeof code === "string" && code.trim() ? code.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Extracts only operational metadata from AI SDK errors. Provider response
 * bodies and prompts are intentionally excluded from the returned value.
 */
export function modelCallFailure(error: unknown): ModelCallFailure {
  const pending = [error];
  const visited = new Set<unknown>();
  let name = "unknown";
  let statusCode: number | null = null;
  let code: string | null = null;

  while (pending.length) {
    const value = pending.shift();
    if (visited.has(value)) continue;
    visited.add(value);
    const item = record(value);
    if (!item) continue;

    if (name === "unknown" && typeof item.name === "string" && item.name.trim()) {
      name = item.name;
    }
    const parsedStatus = Number(item.statusCode);
    if (statusCode === null && Number.isInteger(parsedStatus) && parsedStatus > 0) {
      statusCode = parsedStatus;
    }
    if (!code && typeof item.code === "string" && item.code.trim()) {
      code = item.code.trim();
    }
    if (!code) code = responseCode(item.responseBody);

    if (item.cause) pending.push(item.cause);
    if (Array.isArray(item.errors)) pending.push(...item.errors);
  }

  return { name, statusCode, code };
}

const NON_RETRYABLE_PROVIDER_CODES = new Set([
  "billing_hard_limit_reached",
  "insufficient_quota",
  "invalid_api_key",
  "model_not_found",
]);

export function isModelProviderUnavailable(failure: ModelCallFailure) {
  return (
    (failure.code !== null && NON_RETRYABLE_PROVIDER_CODES.has(failure.code)) ||
    failure.statusCode === 401 ||
    failure.statusCode === 402 ||
    failure.statusCode === 403
  );
}

export class ModelProviderUnavailableError extends Error {
  constructor(readonly failure: ModelCallFailure) {
    const suffix = [
      failure.statusCode === null ? null : String(failure.statusCode),
      failure.code,
    ].filter(Boolean).join(" ");
    super(`Candidate brief model provider is unavailable${suffix ? ` (${suffix})` : ""}`);
    this.name = "ModelProviderUnavailableError";
  }
}
