const NON_SUBSTANTIVE_EVENT_TYPES = new Set([
  "social_graph_signal",
  "identity_observed",
]);

type PublisherEvent = {
  source: string;
  sourceUrl: string;
  type: string;
  confidence?: number;
  tags?: string[];
};

type LicensedEvidence = Pick<PublisherEvent, "confidence" | "tags"> & {
  source?: string;
  sourceLabel?: string;
};

export function isAcceptedPeopleDataLabsEvidence(event: LicensedEvidence) {
  const source = (event.source ?? event.sourceLabel ?? "")
    .trim()
    .toLocaleLowerCase("en-US");
  if (!["people-data-labs", "people data labs"].includes(source)) return true;
  return (event.confidence ?? 0) >= 0.8 && Boolean(event.tags?.some((tag) =>
    ["verified-provider-subject", "model-corroborated-identity"].includes(tag),
  ));
}

export function publisherHostname(sourceUrl: string) {
  try {
    const url = new URL(sourceUrl);
    if (!["https:", "http:"].includes(url.protocol)) return null;
    const hostname = url.hostname.toLocaleLowerCase("en-US").replace(/^www\./, "");
    if (!hostname || hostname === "localhost" || hostname.endsWith(".local")) return null;
    return hostname;
  } catch {
    return null;
  }
}

/**
 * Return the publisher an operator can inspect, rather than the connector that
 * happened to locate the page. A Brave result pointing to GitHub is GitHub,
 * and a profile page is still evidence from the site that published it.
 */
export function evidencePublisher(event: PublisherEvent) {
  if (
    NON_SUBSTANTIVE_EVENT_TYPES.has(event.type) ||
    (event.confidence ?? 1) < 0.65 ||
    !isAcceptedPeopleDataLabsEvidence(event)
  ) return null;
  return publisherHostname(event.sourceUrl);
}

export function evidencePublisherCount(events: PublisherEvent[]) {
  return new Set(
    events.map(evidencePublisher).filter((value): value is string => Boolean(value)),
  ).size;
}
