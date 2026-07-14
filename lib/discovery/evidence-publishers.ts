const NON_SUBSTANTIVE_EVENT_TYPES = new Set([
  "profile_observed",
  "social_graph_signal",
  "identity_observed",
]);

type PublisherEvent = {
  source: string;
  sourceUrl: string;
  type: string;
  confidence?: number;
};

/**
 * Return the publisher an operator can inspect, rather than the connector that
 * happened to locate the page. A Brave result pointing to GitHub is GitHub.
 */
export function evidencePublisher(event: PublisherEvent) {
  if (NON_SUBSTANTIVE_EVENT_TYPES.has(event.type) || (event.confidence ?? 1) < 0.65) return null;
  try {
    return new URL(event.sourceUrl).hostname
      .toLocaleLowerCase("en-US")
      .replace(/^www\./, "");
  } catch {
    const fallback = event.source.trim().toLocaleLowerCase("en-US");
    return fallback || null;
  }
}

export function evidencePublisherCount(events: PublisherEvent[]) {
  return new Set(
    events.map(evidencePublisher).filter((value): value is string => Boolean(value)),
  ).size;
}
