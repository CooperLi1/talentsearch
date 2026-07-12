import type {
  DiscoveryEvent,
  EventType,
  PersonObservation,
  SourceKind,
} from "../types";
import { createEventKey } from "../idempotency";
import { safeIsoDate, sanitizePlainText } from "../security";

export function clamp(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

export function asNumber(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function asStringArray(value: unknown, limit = 20): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => sanitizePlainText(item, 300))
    .filter(Boolean)
    .slice(0, limit);
}

export function createDiscoveryEvent(input: {
  source: SourceKind;
  sourceExternalId: string;
  type: EventType;
  title: string;
  description?: string;
  occurredAt?: unknown;
  sourceUrl: string;
  person: PersonObservation;
  metrics?: Record<string, number>;
  tags?: string[];
  raw?: Record<string, unknown>;
  confidence?: number;
  now: Date;
}): DiscoveryEvent {
  const occurredAt = safeIsoDate(input.occurredAt, input.now);
  const personExternalId = input.person.identities[0]?.externalId;
  return {
    idempotencyKey: createEventKey({
      source: input.source,
      externalId: input.sourceExternalId,
      type: input.type,
      personExternalId,
      occurredAt,
    }),
    source: input.source,
    sourceExternalId: sanitizePlainText(input.sourceExternalId, 500),
    type: input.type,
    title: sanitizePlainText(input.title, 500),
    description: input.description
      ? sanitizePlainText(input.description, 5_000)
      : undefined,
    occurredAt,
    discoveredAt: input.now.toISOString(),
    sourceUrl: input.sourceUrl,
    evidence: [{ label: input.source, url: input.sourceUrl, publishedAt: occurredAt }],
    person: input.person,
    metrics: input.metrics,
    tags: input.tags?.map((tag) => sanitizePlainText(tag, 100)).filter(Boolean),
    raw: input.raw,
    confidence: clamp(input.confidence ?? 0.8),
  };
}

export function getStringOption(
  options: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = options?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function getStringArrayOption(
  options: Record<string, unknown> | undefined,
  key: string,
): string[] {
  const value = options?.[key];
  return asStringArray(value, 100);
}

export async function mapLimit<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const worker = async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(values[index], index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, worker),
  );
  return results;
}
