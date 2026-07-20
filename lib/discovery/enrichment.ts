import { deduplicateEvents } from "./idempotency";
import type {
  ConnectorSettings,
  DiscoveryConnector,
  DiscoveryEvent,
  GraphEdge,
  PersonObservation,
  SourceKind,
} from "./types";
import { mapLimit } from "./connectors/shared";
import { isLinkedInDirectAccessApproved } from "./linkedin-policy";

const MAX_CONNECTORS_PER_PERSON = 12;

function identityKey(identity: PersonObservation["identities"][number]) {
  return `${identity.provider}:${identity.externalId || identity.profileUrl || identity.username || ""}`.toLowerCase();
}

function normalizedIdentityValue(value: string) {
  return value.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, "");
}

function looksLikeHumanName(value: string) {
  const parts = value.trim().split(/\s+/);
  return parts.length >= 2 && parts.length <= 5 && parts.every((part) => /[a-z]{2}/i.test(part));
}

export function mergePersonObservation(current: PersonObservation, observed: PersonObservation) {
  const identities = new Map(current.identities.map((identity) => [identityKey(identity), identity]));
  for (const identity of observed.identities) {
    const key = identityKey(identity);
    const existing = identities.get(key);
    if (!existing || (!existing.verified && identity.verified)) identities.set(key, identity);
  }
  const contactRoutes = new Map(
    (current.contactRoutes ?? []).map((route) => [route.url.toLowerCase(), route]),
  );
  for (const route of observed.contactRoutes ?? []) {
    const existing = contactRoutes.get(route.url.toLowerCase());
    if (!existing || route.confidence > existing.confidence) contactRoutes.set(route.url.toLowerCase(), route);
  }
  const currentNameIsProviderHandle = current.identities.some(
    (identity) =>
      identity.username &&
      normalizedIdentityValue(identity.username) === normalizedIdentityValue(current.displayName),
  );
  const alternateNames = new Map(
    (current.alternateNames ?? []).map((item) => [normalizedIdentityValue(item.name), item]),
  );
  for (const item of observed.alternateNames ?? []) {
    const key = normalizedIdentityValue(item.name);
    const existing = alternateNames.get(key);
    if (key && (!existing || item.confidence > existing.confidence)) alternateNames.set(key, item);
  }
  return {
    ...current,
    displayName:
      currentNameIsProviderHandle && looksLikeHumanName(observed.displayName)
        ? observed.displayName
        : current.displayName,
    headline: current.headline || observed.headline,
    biography: current.biography || observed.biography,
    location: current.location || observed.location,
    affiliations: [...new Set([...(current.affiliations ?? []), ...(observed.affiliations ?? [])])].slice(0, 12),
    alternateNames: [...alternateNames.values()].slice(0, 20),
    avatarUrl: current.avatarUrl || observed.avatarUrl,
    websiteUrl: current.websiteUrl || observed.websiteUrl,
    identities: [...identities.values()].slice(0, 16),
    contactRoutes: [...contactRoutes.values()].slice(0, 12),
  } satisfies PersonObservation;
}

function connectorKindForIdentity(provider: string): SourceKind | null {
  if (provider === "website") return "web-presence";
  return provider as SourceKind;
}

export async function enrichPeople(input: {
  people: PersonObservation[];
  evidenceEvents?: DiscoveryEvent[][];
  researchPasses?: number[];
  connectors: Map<SourceKind, DiscoveryConnector>;
  settings: Partial<Record<SourceKind, ConnectorSettings>>;
  now?: Date;
  concurrency?: number;
  maxConnectorsPerPerson?: number;
  signal?: AbortSignal;
}): Promise<{
  results: Array<{ person: PersonObservation; events: DiscoveryEvent[]; edges: GraphEdge[] }>;
  warnings: string[];
}> {
  const now = input.now ?? new Date();
  const warnings: string[] = [];
  const requestedConnectorLimit = Number(
    input.maxConnectorsPerPerson ?? MAX_CONNECTORS_PER_PERSON,
  );
  const maxConnectorsPerPerson = Number.isFinite(requestedConnectorLimit)
    ? Math.min(MAX_CONNECTORS_PER_PERSON, Math.max(1, Math.floor(requestedConnectorLimit)))
    : MAX_CONNECTORS_PER_PERSON;
  const results = await mapLimit(
    input.people,
    Math.min(8, Math.max(1, input.concurrency ?? 3)),
    async (person, personIndex) => {
      const events: DiscoveryEvent[] = [];
      const evidenceEvents = [...(input.evidenceEvents?.[personIndex] ?? [])];
      const edges: GraphEdge[] = [];
      let enrichedPerson = person;
      const attempted = new Set<SourceKind>();
      const queued = new Set<SourceKind>();
      const queue: SourceKind[] = [];
      const researchPass = Math.max(0, Math.floor(input.researchPasses?.[personIndex] ?? 0));
      const enqueue = (kind: SourceKind | null) => {
        if (
          !kind ||
          queued.has(kind) ||
          attempted.has(kind) ||
          !input.settings[kind]?.enabled ||
          !input.connectors.get(kind)?.enrich
        ) return;
        queued.add(kind);
        // Public web search benefits from every provider-native observation, so
        // keep it at the back while newly verified providers run first.
        if (kind === "brave-enrichment") queue.push(kind);
        else {
          const braveIndex = queue.indexOf("brave-enrichment");
          if (braveIndex === -1) queue.push(kind);
          else queue.splice(braveIndex, 0, kind);
        }
      };
      const enqueueKnownProviders = () => {
        for (const identity of enrichedPerson.identities) {
          if (
            identity.verified !== true &&
            !(identity.provider === "linkedin-manual" && isLinkedInDirectAccessApproved())
          ) continue;
          if (identity.provider === "doi-authorship") {
            enqueue("crossref");
            continue;
          }
          enqueue(connectorKindForIdentity(identity.provider));
        }
        if (enrichedPerson.websiteUrl) enqueue("web-presence");
        // Licensed professional history applies to every candidate, not only
        // those with a provider identity. It runs ahead of public search so
        // search queries can use the licensed headline and affiliations.
        enqueue("people-data-labs");
        // Then try every other enabled research connector: handle-based ones
        // no-op until a verified account exists, while indexes that can search
        // safely by corroborated name extend coverage across sources.
        for (const kind of Object.keys(input.settings) as SourceKind[]) {
          if (kind !== "brave-enrichment") enqueue(kind);
        }
        enqueue("brave-enrichment");
      };
      enqueueKnownProviders();

      // A bounded worker must not repeat the same first providers forever. Rotate
      // the provider-native work by research pass while keeping public search at
      // the back so it can use any stronger identity discovered first.
      const braveQueued = queue.filter((kind) => kind === "brave-enrichment");
      const nativeQueue = queue.filter((kind) => kind !== "brave-enrichment");
      const rotation = nativeQueue.length ? researchPass % nativeQueue.length : 0;
      queue.splice(
        0,
        queue.length,
        ...nativeQueue.slice(rotation),
        ...nativeQueue.slice(0, rotation),
        ...braveQueued,
      );

      while (queue.length && attempted.size < maxConnectorsPerPerson) {
        if (input.signal?.aborted) {
          warnings.push(`Enrichment budget ended while researching ${person.displayName}`);
          break;
        }
        // Public search is the cross-source bridge for every profile. Reserve
        // the final bounded connector slot for it instead of allowing a long
        // list of native identities to crowd it out.
        const braveIndex = queue.indexOf("brave-enrichment");
        const kind = attempted.size === maxConnectorsPerPerson - 1 && braveIndex >= 0
          ? queue.splice(braveIndex, 1)[0]!
          : queue.shift()!;
        queued.delete(kind);
        if (attempted.has(kind)) continue;
        attempted.add(kind);
        const connector = input.connectors.get(kind);
        const settings = input.settings[kind];
        if (!connector || !settings?.enabled) continue;
        try {
          const result = await connector.enrich?.({
            now,
            person: enrichedPerson,
            evidenceEvents,
            settings,
            researchPass: input.researchPasses?.[personIndex] ?? 0,
            signal: input.signal,
          });
          if (result) {
            events.push(...result.events);
            evidenceEvents.push(...result.events);
            edges.push(...(result.edges ?? []));
            warnings.push(...(result.warnings ?? []).map((warning) => `${connector.kind}: ${warning}`));
            for (const event of result.events) {
              enrichedPerson = mergePersonObservation(enrichedPerson, event.person);
            }
            enqueueKnownProviders();
          }
        } catch (error) {
          warnings.push(
            `${connector.displayName} enrichment failed for ${person.displayName}: ${error instanceof Error ? error.message : "unknown error"}`,
          );
          if (input.signal?.aborted) break;
        }
      }
      return { person: enrichedPerson, events: deduplicateEvents(events), edges };
    },
  );

  return { results, warnings };
}
