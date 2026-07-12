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

export async function enrichPeople(input: {
  people: PersonObservation[];
  connectors: Map<SourceKind, DiscoveryConnector>;
  settings: Partial<Record<SourceKind, ConnectorSettings>>;
  now?: Date;
  concurrency?: number;
  signal?: AbortSignal;
}): Promise<{
  results: Array<{ person: PersonObservation; events: DiscoveryEvent[]; edges: GraphEdge[] }>;
  warnings: string[];
}> {
  const now = input.now ?? new Date();
  const warnings: string[] = [];
  const results = await mapLimit(
    input.people,
    Math.min(8, Math.max(1, input.concurrency ?? 3)),
    async (person) => {
      const events: DiscoveryEvent[] = [];
      const edges: GraphEdge[] = [];
      const providers = new Set(person.identities.map((identity) => identity.provider));
      if (input.settings["brave-enrichment"]?.enabled) providers.add("brave-enrichment");
      if (person.websiteUrl && input.settings["web-presence"]?.enabled) {
        providers.add("web-presence");
      }
      for (const provider of providers) {
        const kind = provider as SourceKind;
        const connector = input.connectors.get(kind);
        const settings = input.settings[kind];
        if (!connector || !settings?.enabled) continue;
        if (connector.enrich) {
          try {
            const result = await connector.enrich({
              now,
              person,
              settings,
              signal: input.signal,
            });
            if (result) {
              events.push(...result.events);
              edges.push(...(result.edges ?? []));
              warnings.push(...(result.warnings ?? []).map((warning) => `${connector.kind}: ${warning}`));
            }
          } catch (error) {
            warnings.push(
              `${connector.displayName} enrichment failed for ${person.displayName}: ${error instanceof Error ? error.message : "unknown error"}`,
            );
          }
        }
      }
      return { person, events: deduplicateEvents(events), edges };
    },
  );

  return { results, warnings };
}
