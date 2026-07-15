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
  GraphEdge,
  PersonObservation,
} from "../types";
import { asNumber, createDiscoveryEvent } from "./shared";

type SemanticAuthor = {
  authorId?: string;
  name?: string;
  aliases?: string[];
  url?: string;
  externalIds?: Record<string, string | number | string[] | undefined>;
  affiliations?: string[];
  homepage?: string;
  paperCount?: number;
  citationCount?: number;
  hIndex?: number;
};
type SemanticPaper = {
  paperId: string;
  title: string;
  abstract?: string | null;
  url?: string;
  year?: number;
  publicationDate?: string;
  citationCount?: number;
  influentialCitationCount?: number;
  fieldsOfStudy?: string[];
  externalIds?: Record<string, string | number | undefined>;
  authors?: SemanticAuthor[];
};
type SearchResponse = { data?: SemanticPaper[] };

function apiHeaders(): HeadersInit {
  return process.env.SEMANTIC_SCHOLAR_API_KEY
    ? { "x-api-key": process.env.SEMANTIC_SCHOLAR_API_KEY }
    : {};
}

function safeHomepage(value: unknown): string | undefined {
  const normalized = sanitizePlainText(value, 2_000);
  if (!normalized) return undefined;
  try {
    const url = new URL(normalized);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export function semanticScholarAuthorPerson(
  author: SemanticAuthor,
  sourceUrl: string,
  fallbackId?: string,
  additionalIdentities: PersonObservation["identities"] = [],
): PersonObservation {
  const id = author.authorId || fallbackId;
  if (!id) throw new Error("Semantic Scholar author observation requires an identifier");
  const orcid = normalizeOrcid(author.externalIds?.ORCID ?? author.externalIds?.orcid);
  const displayName = sanitizePlainText(author.name, 200) || "Unknown author";
  return {
    displayName,
    identities: [
      {
        provider: "semantic-scholar",
        externalId: id,
        profileUrl: author.url || (author.authorId
          ? `https://www.semanticscholar.org/author/${author.authorId}`
          : undefined),
        verified: Boolean(author.authorId),
      },
      ...(orcid
        ? [{
            provider: "orcid" as const,
            externalId: orcid,
            profileUrl: orcidProfileUrl(orcid),
            verified: true,
            confidence: 0.99,
            proof: "provider-api" as const,
            proofSourceUrl: sourceUrl,
          }]
        : []),
      ...additionalIdentities,
    ],
    affiliations: (author.affiliations ?? [])
      .map((item) => sanitizePlainText(item, 300))
      .filter(Boolean)
      .slice(0, 12),
    alternateNames: (author.aliases ?? [])
      .map((name) => sanitizePlainText(name, 200))
      .filter((name) => name && name.toLocaleLowerCase("en-US") !== displayName.toLocaleLowerCase("en-US"))
      .slice(0, 12)
      .map((name) => ({
        name,
        sourceUrl,
        confidence: 0.94,
        proof: "provider-profile" as const,
      })),
    websiteUrl: safeHomepage(author.homepage),
    sourceUrl,
  };
}

function paperEvents(paper: SemanticPaper, now: Date): DiscoveryEvent[] {
  const sourceUrl = paper.url || `https://www.semanticscholar.org/paper/${paper.paperId}`;
  return (paper.authors ?? []).slice(0, 20).map((author, index) => {
    const authorship = doiAuthorshipIdentity(paper.externalIds?.DOI, index);
    const person = semanticScholarAuthorPerson(
      author,
      sourceUrl,
      `${paper.paperId}#author-${index}`,
      authorship ? [authorship] : [],
    );
    return createDiscoveryEvent({
      source: "semantic-scholar",
      sourceExternalId: `${paper.paperId}:${author.authorId ?? index}`,
      type: "paper_published",
      title: `${person.displayName} published “${paper.title}”`,
      description: paper.abstract ?? undefined,
      occurredAt: paper.publicationDate ?? (paper.year ? `${paper.year}-01-01` : undefined),
      sourceUrl,
      person,
      metrics: {
        citations: asNumber(paper.citationCount),
        influentialCitations: asNumber(paper.influentialCitationCount),
      },
      tags: paper.fieldsOfStudy,
      confidence: author.authorId ? 0.95 : 0.65,
      now,
    });
  });
}

export class SemanticScholarConnector implements DiscoveryConnector {
  readonly kind = "semantic-scholar" as const;
  readonly displayName = "Semantic Scholar";

  async discover(context: ConnectorRunContext): Promise<ConnectorRunResult> {
    const maxItems = Math.min(100, context.settings.maxItems ?? 40);
    const lookbackDays = Math.min(365, Math.max(1, context.settings.lookbackDays ?? 30));
    const since = new Date(context.now.getTime() - lookbackDays * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const queries = (
      context.settings.queries?.filter(Boolean) ?? [
        "machine learning",
        "robotics",
        "computer security",
      ]
    ).slice(0, 8);
    const fields = [
      "paperId",
      "title",
      "abstract",
      "url",
      "year",
      "publicationDate",
      "citationCount",
      "influentialCitationCount",
      "fieldsOfStudy",
      "externalIds",
      "authors",
    ].join(",");
    const events: DiscoveryEvent[] = [];
    const warnings: string[] = [];
    for (const query of queries) {
      const url = new URL("https://api.semanticscholar.org/graph/v1/paper/search");
      url.searchParams.set("query", query);
      url.searchParams.set("limit", String(Math.min(40, Math.ceil(maxItems / queries.length))));
      url.searchParams.set("fields", fields);
      url.searchParams.set("publicationDateOrYear", `${since}:`);
      try {
        const response = await fetchJson<SearchResponse>(url.toString(), {
          headers: apiHeaders(),
          signal: context.signal,
          rateLimitPerSecond: process.env.SEMANTIC_SCHOLAR_API_KEY ? 1 : 0.2,
        });
        for (const paper of response.data ?? []) events.push(...paperEvents(paper, context.now));
      } catch (error) {
        warnings.push(
          `Semantic Scholar query failed: ${error instanceof Error ? error.message : "unknown error"}`,
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
    const identity = context.person.identities.find(
      (item) => item.provider === "semantic-scholar" && item.verified,
    );
    if (!identity) return null;
    const rateLimitPerSecond = process.env.SEMANTIC_SCHOLAR_API_KEY ? 1 : 0.2;
    const warnings: string[] = [];
    const events: DiscoveryEvent[] = [];
    const profileUrl = `https://www.semanticscholar.org/author/${encodeURIComponent(identity.externalId)}`;
    try {
      const profileFields = "name,aliases,url,externalIds,affiliations,homepage,paperCount,citationCount,hIndex";
      const author = await fetchJson<SemanticAuthor>(
        `https://api.semanticscholar.org/graph/v1/author/${encodeURIComponent(identity.externalId)}?fields=${encodeURIComponent(profileFields)}`,
        {
          headers: apiHeaders(),
          signal: context.signal,
          rateLimitPerSecond,
          retries: 0,
          timeoutMs: 8_000,
        },
      );
      const person = semanticScholarAuthorPerson(author, author.url || profileUrl, identity.externalId);
      events.push(createDiscoveryEvent({
        source: "semantic-scholar",
        sourceExternalId: `author:${identity.externalId}:profile`,
        type: "profile_observed",
        title: `${person.displayName}'s research profile`,
        description: person.affiliations?.length
          ? `Affiliations: ${person.affiliations.join(", ")}`
          : undefined,
        occurredAt: context.now,
        sourceUrl: author.url || profileUrl,
        person,
        metrics: {
          papers: asNumber(author.paperCount),
          citations: asNumber(author.citationCount),
          hIndex: asNumber(author.hIndex),
        },
        confidence: 0.98,
        now: context.now,
      }));
    } catch (error) {
      warnings.push(`Author profile lookup failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }

    try {
      const fields = "paperId,title,abstract,url,year,publicationDate,citationCount,influentialCitationCount,fieldsOfStudy,externalIds,authors";
      const papers = await fetchJson<{ data?: SemanticPaper[] }>(
        `https://api.semanticscholar.org/graph/v1/author/${encodeURIComponent(identity.externalId)}/papers?limit=30&fields=${encodeURIComponent(fields)}`,
        {
          headers: apiHeaders(),
          signal: context.signal,
          rateLimitPerSecond,
          retries: 0,
          timeoutMs: 8_000,
        },
      );
      events.push(...(papers.data ?? []).flatMap((paper) => paperEvents(paper, context.now)));
    } catch (error) {
      warnings.push(`Author paper lookup failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    return { events, warnings };
  }

  async expandGraph(context: ConnectorEnrichmentContext): Promise<GraphEdge[]> {
    const source = context.person.identities.find(
      (item) => item.provider === "semantic-scholar" && item.verified,
    );
    if (!source) return [];
    const fields = "paperId,title,url,authors";
    const papers = await fetchJson<{ data?: SemanticPaper[] }>(
      `https://api.semanticscholar.org/graph/v1/author/${encodeURIComponent(source.externalId)}/papers?limit=30&fields=${encodeURIComponent(fields)}`,
      {
        headers: apiHeaders(),
        signal: context.signal,
        rateLimitPerSecond: process.env.SEMANTIC_SCHOLAR_API_KEY ? 1 : 0.2,
      },
    );
    const edges: GraphEdge[] = [];
    for (const paper of papers.data ?? []) {
      const sourceUrl = paper.url || `https://www.semanticscholar.org/paper/${paper.paperId}`;
      for (const [index, author] of (paper.authors ?? []).entries()) {
        if (!author.authorId || author.authorId === source.externalId) continue;
        edges.push({
          source,
          target: semanticScholarAuthorPerson(
            author,
            sourceUrl,
            `${paper.paperId}#author-${index}`,
          ),
          relation: "coauthors_with",
          weight: 0.18,
          sourceUrl,
          observedAt: context.now.toISOString(),
        });
      }
    }
    return edges
      .sort(
        (left, right) =>
          left.target.displayName.localeCompare(right.target.displayName) ||
          left.sourceUrl.localeCompare(right.sourceUrl),
      )
      .slice(0, 60);
  }
}
