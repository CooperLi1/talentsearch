import { createHash } from "node:crypto";

import type { DiscoveryEvent, EventType, SourceKind } from "./types";

function normalizePart(value: string): string {
  return value.trim().normalize("NFKC").toLocaleLowerCase("en-US");
}

export function stableHash(...parts: Array<string | number | null | undefined>) {
  const value = parts
    .map((part) => normalizePart(String(part ?? "")))
    .join("\u001f");

  return createHash("sha256").update(value).digest("hex");
}

export function createEventKey(input: {
  source: SourceKind;
  externalId: string;
  type: EventType;
  personExternalId?: string;
  occurredAt?: string;
}) {
  const day = input.occurredAt?.slice(0, 10) ?? "undated";
  return stableHash(
    "talent-event-v1",
    input.source,
    input.externalId,
    input.type,
    input.personExternalId,
    day,
  );
}

export function deduplicateEvents(events: DiscoveryEvent[]): DiscoveryEvent[] {
  const byKey = new Map<string, DiscoveryEvent>();

  for (const event of events) {
    const previous = byKey.get(event.idempotencyKey);
    if (!previous || previous.confidence < event.confidence) {
      byKey.set(event.idempotencyKey, event);
    }
  }

  return [...byKey.values()];
}
