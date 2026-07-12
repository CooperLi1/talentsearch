import { fetchJson } from "../http";
import { sanitizePlainText } from "../security";
import type {
  ConnectorEnrichmentContext,
  ConnectorRunContext,
  ConnectorRunResult,
  DiscoveryConnector,
  DiscoveryEvent,
  PersonObservation,
} from "../types";
import { asNumber, createDiscoveryEvent } from "./shared";

type SemanticAuthor = { authorId?: string; name?: string };
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
  authors?: SemanticAuthor[];
};
type SearchResponse = { data?: SemanticPaper[] };

function apiHeaders(): HeadersInit {
  return process.env.SEMANTIC_SCHOLAR_API_KEY
    ? { "x-api-key": process.env.SEMANTIC_SCHOLAR_API_KEY }
    : {};
}

function authorPerson(
  author: SemanticAuthor,
  paper: SemanticPaper,
  index: number,
  sourceUrl: string,
): PersonObservation {
  const id = author.authorId || `${paper.paperId}#author-${index}`;
  return {
    displayName: sanitizePlainText(author.name, 200) || `Unknown author ${index + 1}`,
    identities: [
      {
        provider: "semantic-scholar",
        externalId: id,
        profileUrl: author.authorId
          ? `https://www.semanticscholar.org/author/${author.authorId}`
          : undefined,
        verified: Boolean(author.authorId),
      },
    ],
    sourceUrl,
  };
}

function paperEvents(paper: SemanticPaper, now: Date): DiscoveryEvent[] {
  const sourceUrl = paper.url || `https://www.semanticscholar.org/paper/${paper.paperId}`;
  return (paper.authors ?? []).slice(0, 20).map((author, index) => {
    const person = authorPerson(author, paper, index, sourceUrl);
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
    const queries = context.settings.queries?.filter(Boolean) ?? [
      "machine learning",
      "robotics",
      "computer security",
    ];
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
      "authors",
    ].join(",");
    const events: DiscoveryEvent[] = [];
    const warnings: string[] = [];
    for (const query of queries.slice(0, 6)) {
      const url = new URL("https://api.semanticscholar.org/graph/v1/paper/search");
      url.searchParams.set("query", query);
      url.searchParams.set("limit", String(Math.min(40, Math.ceil(maxItems / queries.length))));
      url.searchParams.set("fields", fields);
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
    const fields = "paperId,title,abstract,url,year,publicationDate,citationCount,influentialCitationCount,fieldsOfStudy,authors";
    const papers = await fetchJson<{ data?: SemanticPaper[] }>(
      `https://api.semanticscholar.org/graph/v1/author/${encodeURIComponent(identity.externalId)}/papers?limit=30&fields=${encodeURIComponent(fields)}`,
      {
        headers: apiHeaders(),
        signal: context.signal,
        rateLimitPerSecond: process.env.SEMANTIC_SCHOLAR_API_KEY ? 1 : 0.2,
      },
    );
    return { events: (papers.data ?? []).flatMap((paper) => paperEvents(paper, context.now)) };
  }
}
