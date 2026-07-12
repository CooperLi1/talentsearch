import { fetchJson } from "../http";
import { sanitizePlainText } from "../security";
import type {
  ConnectorRunContext,
  ConnectorRunResult,
  DiscoveryConnector,
  DiscoveryEvent,
  PersonObservation,
} from "../types";
import { asNumber, createDiscoveryEvent } from "./shared";

type CrossrefAuthor = {
  given?: string;
  family?: string;
  ORCID?: string;
  affiliation?: Array<{ name?: string }>;
};

type CrossrefWork = {
  DOI: string;
  URL?: string;
  title?: string[];
  abstract?: string;
  author?: CrossrefAuthor[];
  published?: { "date-parts"?: number[][] };
  created?: { "date-time"?: string };
  type?: string;
  "is-referenced-by-count"?: number;
  subject?: string[];
};

type CrossrefResponse = {
  message?: { items?: CrossrefWork[] };
};

function publishedAt(work: CrossrefWork): string | undefined {
  const parts = work.published?.["date-parts"]?.[0];
  if (parts?.[0]) {
    return new Date(Date.UTC(parts[0], (parts[1] ?? 1) - 1, parts[2] ?? 1)).toISOString();
  }
  return work.created?.["date-time"];
}

function authorName(author: CrossrefAuthor) {
  return sanitizePlainText([author.given, author.family].filter(Boolean).join(" "), 200);
}

function authorPerson(
  author: CrossrefAuthor,
  work: CrossrefWork,
  index: number,
  sourceUrl: string,
): PersonObservation {
  const orcid = author.ORCID?.replace("http://orcid.org/", "https://orcid.org/");
  return {
    displayName: authorName(author) || `Unknown author ${index + 1}`,
    identities: [
      {
        provider: "crossref",
        externalId: `${work.DOI}#author-${index}`,
        verified: false,
      },
      ...(orcid
        ? [
            {
              provider: "orcid" as const,
              externalId: orcid.replace("https://orcid.org/", ""),
              profileUrl: orcid,
              verified: true,
            },
          ]
        : []),
    ],
    affiliations: author.affiliation
      ?.map((item) => sanitizePlainText(item.name, 300))
      .filter(Boolean),
    sourceUrl,
  };
}

function eventsForWork(work: CrossrefWork, now: Date): DiscoveryEvent[] {
  const sourceUrl = work.URL || `https://doi.org/${work.DOI}`;
  const title = sanitizePlainText(work.title?.[0] ?? work.DOI, 500);
  return (work.author ?? []).slice(0, 20).map((author, index) => {
    const person = authorPerson(author, work, index, sourceUrl);
    return createDiscoveryEvent({
      source: "crossref",
      sourceExternalId: `${work.DOI}:${index}`,
      type: "paper_published",
      title: `${person.displayName} published “${title}”`,
      description: work.abstract
        ? sanitizePlainText(work.abstract.replace(/<[^>]+>/g, " "), 3_000)
        : undefined,
      occurredAt: publishedAt(work),
      sourceUrl,
      person,
      metrics: { citations: asNumber(work["is-referenced-by-count"]) },
      tags: work.subject,
      confidence: author.ORCID ? 0.96 : 0.68,
      now,
    });
  });
}

export class CrossrefConnector implements DiscoveryConnector {
  readonly kind = "crossref" as const;
  readonly displayName = "Crossref";

  async discover(context: ConnectorRunContext): Promise<ConnectorRunResult> {
    const maxItems = Math.min(200, context.settings.maxItems ?? 45);
    const lookbackDays = Math.min(365, context.settings.lookbackDays ?? 21);
    const since = new Date(context.now.getTime() - lookbackDays * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const queries = context.settings.queries?.filter(Boolean) ?? [
      "machine learning",
      "robotics",
      "cryptography",
    ];
    const events: DiscoveryEvent[] = [];
    const warnings: string[] = [];
    for (const query of queries.slice(0, 6)) {
      const url = new URL("https://api.crossref.org/works");
      url.searchParams.set("query", query);
      url.searchParams.set("filter", `from-pub-date:${since}`);
      url.searchParams.set("sort", "published");
      url.searchParams.set("order", "desc");
      url.searchParams.set("rows", String(Math.min(40, Math.ceil(maxItems / queries.length))));
      url.searchParams.set(
        "select",
        "DOI,URL,title,abstract,author,published,created,type,is-referenced-by-count,subject",
      );
      if (process.env.CROSSREF_EMAIL) url.searchParams.set("mailto", process.env.CROSSREF_EMAIL);
      try {
        const response = await fetchJson<CrossrefResponse>(url.toString(), {
          signal: context.signal,
          rateLimitPerSecond: 3,
        });
        for (const work of response.message?.items ?? []) {
          events.push(...eventsForWork(work, context.now));
        }
      } catch (error) {
        warnings.push(
          `Crossref query failed: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }
    }
    return {
      events: events.slice(0, maxItems),
      cursor: { since: context.now.toISOString() },
      warnings,
    };
  }
}
