import { fetchJson } from "../http";
import { doiAuthorshipIdentity } from "../doi";
import { normalizeOrcid, orcidProfileUrl } from "../orcid";
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
  display_name_alternatives?: string[];
  last_known_institutions?: Array<{ display_name?: string }>;
  affiliations?: Array<{ institution?: { display_name?: string } }>;
};

function comparableName(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function comparableInstitution(value: string) {
  return comparableName(value).replace(/\b(the|of|at|and)\b/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * A name-only search can bind the wrong scholar, so an author qualifies only
 * when the name matches exactly and a stated institution corroborates a known
 * affiliation — and only when exactly one searched author clears that bar.
 */
export function matchAuthorByNameAndAffiliation(
  authors: OpenAlexAuthor[],
  displayName: string,
  affiliations: string[],
): OpenAlexAuthor | null {
  const wanted = comparableName(displayName);
  const knownInstitutions = affiliations.map(comparableInstitution).filter((value) => value.length >= 4);
  if (!wanted || wanted.split(" ").length < 2 || !knownInstitutions.length) return null;
  const matches = authors.filter((author) => {
    const names = [author.display_name, ...(author.display_name_alternatives ?? [])]
      .map(comparableName);
    if (!names.includes(wanted)) return false;
    const institutions = [
      ...(author.last_known_institutions ?? []).map((item) => item.display_name ?? ""),
      ...(author.affiliations ?? []).map((item) => item.institution?.display_name ?? ""),
    ].map(comparableInstitution).filter(Boolean);
    return institutions.some((institution) =>
      knownInstitutions.some(
        (known) => institution.includes(known) || known.includes(institution),
      ),
    );
  });
  return matches.length === 1 ? matches[0]! : null;
}

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

type OpenAlexAuthorResponse = {
  results?: OpenAlexAuthor[];
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
  const orcid = normalizeOrcid(author.orcid);
  return [
    {
      provider: "openalex",
      externalId: author.id.replace("https://openalex.org/", ""),
      profileUrl: author.id,
      verified: true,
    },
    ...(orcid
      ? [
          {
            provider: "orcid" as const,
            externalId: orcid,
            profileUrl: orcidProfileUrl(orcid),
            verified: true,
          },
        ]
      : []),
  ];
}

function person(
  authorship: OpenAlexAuthorship,
  sourceUrl: string,
  doi?: string | null,
  authorIndex?: number,
): PersonObservation {
  const authorshipIdentity = authorIndex === undefined
    ? undefined
    : doiAuthorshipIdentity(doi, authorIndex);
  return {
    displayName: sanitizePlainText(authorship.author.display_name, 200),
    identities: [
      ...identity(authorship.author),
      ...(authorshipIdentity ? [authorshipIdentity] : []),
    ],
    affiliations: authorship.institutions
      ?.map((item) => sanitizePlainText(item.display_name, 300))
      .filter(Boolean),
    sourceUrl,
  };
}

function workUrl(work: OpenAlexWork) {
  return work.primary_location?.landing_page_url || work.doi || work.id;
}

function normalizedOpenAlexAuthorId(value: string) {
  return value.replace(/^https:\/\/openalex\.org\//, "").toLocaleUpperCase("en-US");
}

export function openAlexWorkEvents(
  work: OpenAlexWork,
  now: Date,
  targetAuthorId?: string,
): DiscoveryEvent[] {
  const sourceUrl = workUrl(work);
  const topics = work.topics?.slice(0, 8).map((topic) => topic.display_name) ?? [];
  const normalizedTarget = targetAuthorId
    ? normalizedOpenAlexAuthorId(targetAuthorId)
    : undefined;
  return (work.authorships ?? []).slice(0, 20).flatMap((authorship, authorIndex) => {
    // The works endpoint returns full author lists. During enrichment, only
    // the requested OpenAlex author is evidence for the current candidate.
    if (
      normalizedTarget &&
      normalizedOpenAlexAuthorId(authorship.author.id) !== normalizedTarget
    ) return [];
    return [createDiscoveryEvent({
      source: "openalex",
      sourceExternalId: `${work.id}:${authorship.author.id}`,
      type: "paper_published",
      title: `${authorship.author.display_name} published “${work.display_name}”`,
      description: topics.length ? `Research areas: ${topics.join(", ")}` : undefined,
      occurredAt: work.publication_date,
      sourceUrl,
      person: person(authorship, sourceUrl, work.doi, authorIndex),
      metrics: { citations: asNumber(work.cited_by_count) },
      tags: topics,
      confidence: authorship.author.id ? 0.96 : 0.7,
      now,
    })];
  });
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
        for (const work of response.results ?? []) {
          events.push(...openAlexWorkEvents(work, context.now));
        }
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
    const knownAuthor = context.person.identities.find((item) => item.provider === "openalex");
    let authorId = knownAuthor?.externalId.replace(/^https:\/\/openalex\.org\//, "");
    if (!authorId) {
      const orcid = context.person.identities
        .filter((item) => item.provider === "orcid" && item.verified === true)
        .map((item) => normalizeOrcid(item.externalId))
        .find(Boolean);
      if (orcid) {
        const authorUrl = new URL("https://api.openalex.org/authors");
        authorUrl.searchParams.set("filter", `orcid:${orcid}`);
        authorUrl.searchParams.set("per-page", "1");
        authenticate(authorUrl);
        const authorResponse = await fetchJson<OpenAlexAuthorResponse>(authorUrl.toString(), {
          signal: context.signal,
          rateLimitPerSecond: 4,
          retries: 1,
          timeoutMs: 8_000,
        });
        authorId = authorResponse.results?.[0]?.id.replace("https://openalex.org/", "");
        if (!authorId) return { events: [], warnings: [`No OpenAlex author matched ORCID ${orcid}`] };
      } else {
        // Cross-source fallback: scholars discovered on other indexes gain
        // OpenAlex coverage through a corroborated author-name search.
        const searchUrl = new URL("https://api.openalex.org/authors");
        searchUrl.searchParams.set("search", context.person.displayName);
        searchUrl.searchParams.set("per-page", "10");
        authenticate(searchUrl);
        const searchResponse = await fetchJson<OpenAlexAuthorResponse>(searchUrl.toString(), {
          signal: context.signal,
          rateLimitPerSecond: 4,
          retries: 1,
          timeoutMs: 8_000,
        });
        const matched = matchAuthorByNameAndAffiliation(
          searchResponse.results ?? [],
          context.person.displayName,
          context.person.affiliations ?? [],
        );
        if (!matched) return null;
        authorId = matched.id.replace("https://openalex.org/", "");
      }
    }
    const url = new URL("https://api.openalex.org/works");
    url.searchParams.set("filter", `author.id:${authorId},is_retracted:false`);
    url.searchParams.set("sort", "publication_date:desc,cited_by_count:desc");
    url.searchParams.set("per-page", "25");
    authenticate(url);
    const response = await fetchJson<OpenAlexResponse>(url.toString(), {
      signal: context.signal,
      rateLimitPerSecond: 4,
      retries: 1,
      timeoutMs: 8_000,
    });
    return {
      events: (response.results ?? []).flatMap((work) =>
        openAlexWorkEvents(work, context.now, authorId),
      ),
    };
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
