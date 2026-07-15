import { fetchJson } from "../http";
import { doiAuthorshipIdentity, parseDoiAuthorshipIdentity } from "../doi";
import { normalizeOrcid, orcidProfileUrl } from "../orcid";
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

type CrossrefWorkResponse = {
  message?: CrossrefWork;
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
  const orcid = normalizeOrcid(author.ORCID);
  const authorship = doiAuthorshipIdentity(work.DOI, index);
  return {
    displayName: authorName(author) || `Unknown author ${index + 1}`,
    identities: [
      {
        ...(authorship ?? {
          provider: "crossref" as const,
          externalId: `${work.DOI}#author-${index}`,
          verified: false,
        }),
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
      confidence: person.identities.some((identity) => identity.provider === "orcid") ? 0.96 : 0.68,
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
    const queries = (
      context.settings.queries?.filter(Boolean) ?? [
        "machine learning",
        "robotics",
        "cryptography",
      ]
    ).slice(0, 8);
    const events: DiscoveryEvent[] = [];
    const warnings: string[] = [];
    for (const query of queries) {
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

  async enrich(context: ConnectorEnrichmentContext): Promise<ConnectorRunResult | null> {
    const authorship = context.person.identities
      .filter((identity) => identity.provider === "doi-authorship" && identity.verified === true)
      .map((identity) => parseDoiAuthorshipIdentity(identity.externalId))
      .find(Boolean);
    if (!authorship) return null;

    const url = new URL(`https://api.crossref.org/works/${encodeURIComponent(authorship.doi)}`);
    if (process.env.CROSSREF_EMAIL) url.searchParams.set("mailto", process.env.CROSSREF_EMAIL);
    const response = await fetchJson<CrossrefWorkResponse>(url.toString(), {
      signal: context.signal,
      rateLimitPerSecond: 3,
      retries: 1,
      timeoutMs: 8_000,
    });
    const work = response.message;
    if (!work) return { events: [], warnings: [`Crossref did not return DOI ${authorship.doi}`] };
    const expectedIdentity = `${authorship.doi}#author-${authorship.authorIndex}`;
    const matched = eventsForWork(work, context.now).filter((event) =>
      event.person.identities.some((identity) =>
        identity.provider === "doi-authorship" && identity.externalId === expectedIdentity,
      ),
    );
    return matched.length
      ? { events: matched }
      : { events: [], warnings: [`Crossref DOI ${authorship.doi} did not contain the expected author position`] };
  }
}
