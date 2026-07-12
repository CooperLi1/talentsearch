import { XMLParser } from "fast-xml-parser";

import { smartFetch } from "../http";
import { stableHash } from "../idempotency";
import { sanitizePlainText } from "../security";
import type {
  ConnectorRunContext,
  ConnectorRunResult,
  DiscoveryConnector,
  EventType,
  PersonObservation,
  SourceKind,
} from "../types";
import { createDiscoveryEvent } from "./shared";

type FeedEntry = Record<string, unknown>;

function list<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function scalar(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return scalar(record["#text"] ?? record.name ?? record["@_href"] ?? "");
  }
  return "";
}

function entryUrl(entry: FeedEntry, feedUrl: string): string {
  const links = list(entry.link as Record<string, unknown> | string | undefined);
  const alternate = links.find((item) => {
    if (item === null || typeof item !== "object") return false;
    const link = item as Record<string, unknown>;
    return (!link["@_rel"] || link["@_rel"] === "alternate") && Boolean(link["@_href"]);
  });
  const raw = scalar(alternate ?? links[0] ?? entry.guid ?? feedUrl);
  try {
    return new URL(raw, feedUrl).toString();
  } catch {
    return feedUrl;
  }
}

function entryAuthor(entry: FeedEntry): string {
  return sanitizePlainText(
    scalar(entry.author) || scalar(entry.creator) || scalar(entry.contributor),
    200,
  );
}

export class FeedConnector implements DiscoveryConnector {
  readonly kind: SourceKind;
  readonly displayName: string;

  constructor(
    kind: SourceKind = "rss",
    displayName = "RSS and Atom feeds",
    private readonly eventType: EventType = "community_recognition",
  ) {
    this.kind = kind;
    this.displayName = displayName;
  }

  async discover(context: ConnectorRunContext): Promise<ConnectorRunResult> {
    const urls = context.settings.urls?.filter(Boolean) ?? [];
    const maxItems = Math.min(250, context.settings.maxItems ?? 80);
    const events = [];
    const warnings: string[] = [];
    const parser = new XMLParser({
      ignoreAttributes: false,
      removeNSPrefix: true,
      trimValues: true,
    });

    for (const feedUrl of urls.slice(0, 30)) {
      try {
        const response = await smartFetch(feedUrl, {
          respectRobots: true,
          signal: context.signal,
          rateLimitPerSecond: 0.5,
          maxBytes: 3_000_000,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const parsed = parser.parse(await response.text()) as {
          rss?: { channel?: { item?: FeedEntry | FeedEntry[] } };
          feed?: { entry?: FeedEntry | FeedEntry[] };
        };
        const entries = list(parsed.rss?.channel?.item ?? parsed.feed?.entry).slice(0, maxItems);
        for (const entry of entries) {
          const author = entryAuthor(entry);
          if (!author) continue;
          const sourceUrl = entryUrl(entry, feedUrl);
          const externalId =
            scalar(entry.guid) || scalar(entry.id) || stableHash(sourceUrl, scalar(entry.title));
          const person: PersonObservation = {
            displayName: author,
            identities: [
              {
                provider: this.kind,
                externalId: stableHash(feedUrl, author),
                verified: false,
              },
            ],
            sourceUrl,
          };
          events.push(
            createDiscoveryEvent({
              source: this.kind,
              sourceExternalId: externalId,
              type: this.eventType,
              title: `${author}: ${sanitizePlainText(scalar(entry.title), 500)}`,
              description:
                sanitizePlainText(
                  scalar(entry.summary) || scalar(entry.description) || scalar(entry.content),
                  3_000,
                ) || undefined,
              occurredAt: scalar(entry.published) || scalar(entry.updated) || scalar(entry.pubDate),
              sourceUrl,
              person,
              tags: ["feed"],
              confidence: 0.62,
              now: context.now,
            }),
          );
        }
      } catch (error) {
        warnings.push(
          `${feedUrl}: ${error instanceof Error ? error.message : "unknown error"}`,
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
