import { fetchJson } from "../http";
import { sanitizePlainText } from "../security";
import type {
  ConnectorEnrichmentContext,
  ConnectorRunContext,
  ConnectorRunResult,
  DiscoveryConnector,
  DiscoveryEvent,
  ExternalIdentity,
  GraphEdge,
  PersonObservation,
} from "../types";
import { asNumber, createDiscoveryEvent } from "./shared";

type OpenAlexAuthor = {
  id: string;
  display_name: string;
  orcid?: string | null;
};

type OpenAlexAuthorship = {
  author: OpenAlexAuthor;
  institutions?: Array<{ display_name: string }>;
  is_corresponding?: boolean;
};

type OpenAlexWork = {
  id: string;
  doi?: string | null;
  display_name: string;
  publication_date?: string;
  cited_by_count?: number;
  type?: string;
  primary_location?: { landing_page_url?: string | null };
  topics?: Array<{ display_name: string; score?: number }>;
  authorships?: OpenAlexAuthorship[];
};

type OpenAlexResponse = {
  results?: OpenAlexWork[];
  meta?: { next_cursor?: string | null };
};

function authenticate(url: URL) {
  const apiKey = process.env.OPENALEX_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("OPENALEX_API_KEY is required for OpenAlex requests");
  }
  url.searchParams.set("api_key", apiKey);
  // OpenAlex has ignored mailto since February 2026. Retaining it is harmless
  // for deployments that still use the address for request attribution.
  const email = process.env.OPENALEX_EMAIL?.trim();
  if (email) url.searchParams.set("mailto", email);
}

function identity(author: OpenAlexAuthor): ExternalIdentity[] {
  return [
    {
      provider: "openalex",
      externalId: author.id.replace("https://openalex.org/", ""),
      profileUrl: author.id,
      verified: true,
    },
    ...(author.orcid
      ? [
          {
            provider: "orcid" as const,
            externalId: author.orcid.replace("https://orcid.org/", ""),
            profileUrl: author.orcid,
            verified: true,
          },
        ]
      : []),
  ];
}

function person(authorship: OpenAlexAuthorship, sourceUrl: string): PersonObservation {
  return {
    displayName: sanitizePlainText(authorship.author.display_name, 200),
    identities: identity(authorship.author),
    affiliations: authorship.institutions
      ?.map((item) => sanitizePlainText(item.display_name, 300))
      .filter(Boolean),
    sourceUrl,
  };
}

function workUrl(work: OpenAlexWork) {
  return work.primary_location?.landing_page_url || work.doi || work.id;
}

function workEvents(work: OpenAlexWork, now: Date): DiscoveryEvent[] {
  const sourceUrl = workUrl(work);
  const topics = work.topics?.slice(0, 8).map((topic) => topic.display_name) ?? [];
  return (work.authorships ?? []).slice(0, 20).map((authorship) =>
    createDiscoveryEvent({
      source: "openalex",
      sourceExternalId: `${work.id}:${authorship.author.id}`,
      type: "paper_published",
      title: `${authorship.author.display_name} published “${work.display_name}”`,
      description: topics.length ? `Research areas: ${topics.join(", ")}` : undefined,
      occurredAt: work.publication_date,
      sourceUrl,
      person: person(authorship, sourceUrl),
      metrics: { citations: asNumber(work.cited_by_count) },
      tags: topics,
      confidence: authorship.author.id ? 0.96 : 0.7,
      now,
    }),
  );
}

export class OpenAlexConnector implements DiscoveryConnector {
  readonly kind = "openalex" as const;
  readonly displayName = "OpenAlex";

  async discover(context: ConnectorRunContext): Promise<ConnectorRunResult> {
    const maxItems = Math.min(200, context.settings.maxItems ?? 50);
    const lookbackDays = Math.min(365, context.settings.lookbackDays ?? 21);
    const since = new Date(context.now.getTime() - lookbackDays * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const queries = (
      context.settings.queries?.filter(Boolean) ?? [
        "artificial intelligence",
        "robotics",
        "cryptography",
        "computational biology",
      ]
    ).slice(0, 8);
    const events: DiscoveryEvent[] = [];
    const warnings: string[] = [];

    for (const query of queries) {
      const url = new URL("https://api.openalex.org/works");
      url.searchParams.set("search", query);
      url.searchParams.set("filter", `from_publication_date:${since},is_retracted:false`);
      url.searchParams.set("sort", "publication_date:desc,cited_by_count:desc");
      url.searchParams.set("per-page", String(Math.min(50, Math.ceil(maxItems / queries.length))));
      authenticate(url);
      try {
        const response = await fetchJson<OpenAlexResponse>(url.toString(), {
          signal: context.signal,
          rateLimitPerSecond: 4,
        });
        for (const work of response.results ?? []) events.push(...workEvents(work, context.now));
      } catch (error) {
        warnings.push(
          `OpenAlex query failed: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }
    }

    return {
      events: events.slice(0, maxItems),
      cursor: { since: context.now.toISOString() },
      warnings,
    };
  }

  async enrich(context: ConnectorEnrichmentContext): Promise<ConnectorRunResult | null> {
    const author = context.person.identities.find((item) => item.provider === "openalex");
    if (!author) return null;
    const authorId = author.externalId.replace(/^https:\/\/openalex\.org\//, "");
    const url = new URL("https://api.openalex.org/works");
    url.searchParams.set("filter", `author.id:${authorId},is_retracted:false`);
    url.searchParams.set("sort", "publication_date:desc,cited_by_count:desc");
    url.searchParams.set("per-page", "25");
    authenticate(url);
    const response = await fetchJson<OpenAlexResponse>(url.toString(), {
      signal: context.signal,
      rateLimitPerSecond: 4,
    });
    return { events: (response.results ?? []).flatMap((work) => workEvents(work, context.now)) };
  }

  async expandGraph(context: ConnectorEnrichmentContext): Promise<GraphEdge[]> {
    const source = context.person.identities.find((item) => item.provider === "openalex");
    if (!source) return [];
    const authorId = source.externalId.replace(/^https:\/\/openalex\.org\//, "");
    const url = new URL("https://api.openalex.org/works");
    url.searchParams.set("filter", `author.id:${authorId},is_retracted:false`);
    url.searchParams.set("sort", "publication_date:desc");
    url.searchParams.set("per-page", "20");
    authenticate(url);
    const response = await fetchJson<OpenAlexResponse>(url.toString(), {
      signal: context.signal,
      rateLimitPerSecond: 4,
    });
    const edges = new Map<string, GraphEdge>();
    for (const work of response.results ?? []) {
      for (const authorship of work.authorships ?? []) {
        const targetIds = identity(authorship.author);
        if (targetIds.some((item) => item.externalId === source.externalId)) continue;
        const key = targetIds[0]?.externalId;
        if (!key) continue;
        const existing = edges.get(key);
        edges.set(key, {
          source,
          target: person(authorship, workUrl(work)),
          relation: "coauthors_with",
          weight: Math.min(1, (existing?.weight ?? 0) + 0.18),
          sourceUrl: workUrl(work),
          observedAt: context.now.toISOString(),
        });
      }
    }
    return [...edges.values()].slice(0, 50);
  }
}
