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

const GENERIC_PUBLISHER_BYLINES = new Set([
  "cloudflare",
  "github",
  "github blog",
  "gitlab",
  "mozilla",
  "mozilla hacks",
]);

function list<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function scalarValues(value: unknown): string[] {
  if (typeof value === "string" || typeof value === "number") return [String(value)];
  if (Array.isArray(value)) {
    return value.flatMap(scalarValues);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return scalarValues(record["#text"] ?? record.name ?? record["@_href"] ?? "");
  }
  return [];
}

function scalar(value: unknown): string {
  return scalarValues(value).find(Boolean) ?? "";
}

export function interleaveFeedResults<T>(groups: readonly (readonly T[])[], limit: number): T[] {
  if (limit <= 0) return [];

  const interleaved: T[] = [];
  for (let itemIndex = 0; interleaved.length < limit; itemIndex += 1) {
    let foundItem = false;
    for (const group of groups) {
      if (itemIndex >= group.length) continue;
      foundItem = true;
      interleaved.push(group[itemIndex]!);
      if (interleaved.length >= limit) break;
    }
    if (!foundItem) break;
  }
  return interleaved;
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

export function extractFeedAuthors(entry: Record<string, unknown>): string[] {
  const authors: string[] = [];
  const seen = new Set<string>();
  for (const raw of [entry.author, entry.creator, entry.contributor].flatMap(scalarValues)) {
    const author = sanitizePlainText(raw, 200);
    const normalized = author
      .toLocaleLowerCase("en-US")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
    if (
      !author ||
      !normalized ||
      GENERIC_PUBLISHER_BYLINES.has(normalized) ||
      /(?:^| )(?:staff|team)$/u.test(normalized) ||
      seen.has(normalized)
    ) {
      continue;
    }
    seen.add(normalized);
    authors.push(author);
    if (authors.length >= 8) break;
  }
  return authors;
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
    const urls = [...new Set(context.settings.urls?.filter(Boolean) ?? [])].slice(0, 30);
    const maxItems = Math.min(250, context.settings.maxItems ?? 80);
    const eventsByFeed: Array<ReturnType<typeof createDiscoveryEvent>[]> = [];
    const warnings: string[] = [];
    const parser = new XMLParser({
      ignoreAttributes: false,
      removeNSPrefix: true,
      trimValues: true,
    });

    for (const feedUrl of urls) {
      const feedEvents: ReturnType<typeof createDiscoveryEvent>[] = [];
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
        entries: for (const entry of entries) {
          const authors = extractFeedAuthors(entry);
          if (!authors.length) continue;
          const sourceUrl = entryUrl(entry, feedUrl);
          const entryExternalId =
            scalar(entry.guid) || scalar(entry.id) || stableHash(sourceUrl, scalar(entry.title));
          for (const author of authors) {
            const normalizedAuthor = author.toLocaleLowerCase("en-US");
            const person: PersonObservation = {
              displayName: author,
              identities: [
                {
                  provider: this.kind,
                  externalId: stableHash(feedUrl, normalizedAuthor),
                  verified: false,
                },
              ],
              sourceUrl,
            };
            feedEvents.push(
              createDiscoveryEvent({
                source: this.kind,
                sourceExternalId: stableHash(entryExternalId, normalizedAuthor),
                type: this.eventType,
                title: `${author}: ${sanitizePlainText(scalar(entry.title), 500)}`,
                description:
                  sanitizePlainText(
                    scalar(entry.summary) || scalar(entry.description) || scalar(entry.content),
                    3_000,
                  ) || undefined,
                occurredAt:
                  scalar(entry.published) || scalar(entry.updated) || scalar(entry.pubDate),
                sourceUrl,
                person,
                tags: ["feed"],
                confidence: 0.62,
                now: context.now,
              }),
            );
            if (feedEvents.length >= maxItems) break entries;
          }
        }
      } catch (error) {
        warnings.push(
          `${feedUrl}: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }
      eventsByFeed.push(feedEvents);
    }

    return {
      events: interleaveFeedResults(eventsByFeed, maxItems),
      cursor: { since: context.now.toISOString() },
      warnings,
    };
  }
}
