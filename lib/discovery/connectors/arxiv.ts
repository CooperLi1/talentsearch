import { XMLParser } from "fast-xml-parser";

import { smartFetch } from "../http";
import { sanitizePlainText } from "../security";
import type {
  ConnectorRunContext,
  ConnectorRunResult,
  DiscoveryConnector,
  PersonObservation,
} from "../types";
import { createDiscoveryEvent } from "./shared";

type ArxivEntry = {
  id?: string;
  updated?: string;
  published?: string;
  title?: string;
  summary?: string;
  author?: Array<{ name?: string }> | { name?: string };
  category?: Array<{ "@_term"?: string }> | { "@_term"?: string };
  link?: Array<{ "@_href"?: string; "@_rel"?: string }> | { "@_href"?: string; "@_rel"?: string };
};

function list<T>(value: T | T[] | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function eventsForEntry(entry: ArxivEntry, now: Date) {
  const arxivId = sanitizePlainText(entry.id?.split("/abs/").pop(), 200);
  const sourceUrl =
    list(entry.link).find((link) => link["@_rel"] === "alternate")?.["@_href"] ||
    entry.id ||
    `https://arxiv.org/abs/${arxivId}`;
  const categories = list(entry.category)
    .map((item) => sanitizePlainText(item["@_term"], 100))
    .filter(Boolean);

  return list(entry.author).slice(0, 20).map((author, index) => {
    const displayName = sanitizePlainText(author.name, 200) || `Unknown author ${index + 1}`;
    const person: PersonObservation = {
      displayName,
      identities: [
        {
          provider: "arxiv",
          externalId: `${arxivId}#author-${index}`,
          verified: false,
        },
      ],
      sourceUrl,
    };
    return createDiscoveryEvent({
      source: "arxiv",
      sourceExternalId: `${arxivId}:${index}`,
      type: "paper_published",
      title: `${displayName} published “${sanitizePlainText(entry.title, 500)}”`,
      description: sanitizePlainText(entry.summary, 3_000) || undefined,
      occurredAt: entry.published ?? entry.updated,
      sourceUrl,
      person,
      tags: categories,
      confidence: 0.66,
      now,
    });
  });
}

export class ArxivConnector implements DiscoveryConnector {
  readonly kind = "arxiv" as const;
  readonly displayName = "arXiv";

  async discover(context: ConnectorRunContext): Promise<ConnectorRunResult> {
    const maxItems = Math.min(150, context.settings.maxItems ?? 40);
    const queries = context.settings.queries?.filter(Boolean) ?? [
      "cat:cs.AI",
      "cat:cs.RO",
      "cat:cs.CR",
      "cat:q-bio.QM",
    ];
    const events = [];
    const warnings: string[] = [];
    const parser = new XMLParser({ ignoreAttributes: false });
    for (const query of queries.slice(0, 8)) {
      const url = new URL("https://export.arxiv.org/api/query");
      url.searchParams.set("search_query", query.includes(":") ? query : `all:${query}`);
      url.searchParams.set("start", "0");
      url.searchParams.set("max_results", String(Math.min(30, Math.ceil(maxItems / queries.length))));
      url.searchParams.set("sortBy", "submittedDate");
      url.searchParams.set("sortOrder", "descending");
      try {
        const response = await smartFetch(url.toString(), {
          signal: context.signal,
          rateLimitPerSecond: 0.3,
          timeoutMs: 20_000,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const parsed = parser.parse(await response.text()) as { feed?: { entry?: ArxivEntry | ArxivEntry[] } };
        for (const entry of list(parsed.feed?.entry)) {
          events.push(...eventsForEntry(entry, context.now));
        }
      } catch (error) {
        warnings.push(
          `arXiv query failed: ${error instanceof Error ? error.message : "unknown error"}`,
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
