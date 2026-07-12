import * as cheerio from "cheerio";

import { smartFetch } from "../http";
import { stableHash } from "../idempotency";
import { sanitizePlainText } from "../security";
import type {
  ConnectorRunContext,
  ConnectorRunResult,
  DiscoveryEvent,
  DiscoveryConnector,
  EventType,
  PersonObservation,
  SourceKind,
} from "../types";
import { asNumber, createDiscoveryEvent } from "./shared";

type PageDefinition = {
  url: string;
  itemSelector: string;
  nameSelector: string;
  titleSelector?: string;
  descriptionSelector?: string;
  linkSelector?: string;
  dateSelector?: string;
  rankSelector?: string;
  affiliationSelector?: string;
  eventName?: string;
  eventType?: EventType;
};

function pageDefinitions(value: unknown): PageDefinition[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .map((item) => ({
      url: sanitizePlainText(item.url, 2_000),
      itemSelector: sanitizePlainText(item.itemSelector, 300),
      nameSelector: sanitizePlainText(item.nameSelector, 300),
      titleSelector: sanitizePlainText(item.titleSelector, 300) || undefined,
      descriptionSelector: sanitizePlainText(item.descriptionSelector, 300) || undefined,
      linkSelector: sanitizePlainText(item.linkSelector, 300) || undefined,
      dateSelector: sanitizePlainText(item.dateSelector, 300) || undefined,
      rankSelector: sanitizePlainText(item.rankSelector, 300) || undefined,
      affiliationSelector: sanitizePlainText(item.affiliationSelector, 300) || undefined,
      eventName: sanitizePlainText(item.eventName, 300) || undefined,
      eventType: [
        "competition_result",
        "hackathon_result",
        "fellowship_or_grant",
        "community_recognition",
      ].includes(String(item.eventType))
        ? (item.eventType as EventType)
        : undefined,
    }))
    .filter((item) => item.url && item.itemSelector && item.nameSelector)
    .slice(0, 30);
}

export class StructuredResultsConnector implements DiscoveryConnector {
  readonly kind: SourceKind;
  readonly displayName: string;

  constructor(
    kind: SourceKind = "structured-results",
    displayName = "Public competition and hackathon results",
    private readonly defaultEventType: EventType = "competition_result",
  ) {
    this.kind = kind;
    this.displayName = displayName;
  }

  async discover(context: ConnectorRunContext): Promise<ConnectorRunResult> {
    const pages = pageDefinitions(context.settings.options?.pages);
    const maxItems = Math.min(500, context.settings.maxItems ?? 120);
    const events: DiscoveryEvent[] = [];
    const warnings: string[] = [];

    for (const page of pages) {
      try {
        const response = await smartFetch(page.url, {
          respectRobots: true,
          signal: context.signal,
          rateLimitPerSecond: 0.25,
          timeoutMs: 15_000,
          maxBytes: 5_000_000,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const $ = cheerio.load(await response.text());
        $(page.itemSelector)
          .slice(0, maxItems)
          .each((index, element) => {
            const item = $(element);
            const name = sanitizePlainText(item.find(page.nameSelector).first().text(), 200);
            if (!name) return;
            const rawHref = page.linkSelector
              ? item.find(page.linkSelector).first().attr("href")
              : undefined;
            let sourceUrl = page.url;
            if (rawHref) {
              try {
                sourceUrl = new URL(rawHref, page.url).toString();
              } catch {
                sourceUrl = page.url;
              }
            }
            const rankText = page.rankSelector
              ? sanitizePlainText(item.find(page.rankSelector).first().text(), 100)
              : "";
            const rank = Number(rankText.replace(/[^0-9.]/g, ""));
            const affiliation = page.affiliationSelector
              ? sanitizePlainText(item.find(page.affiliationSelector).first().text(), 300)
              : "";
            const eventName =
              page.eventName ||
              (page.titleSelector
                ? sanitizePlainText(item.find(page.titleSelector).first().text(), 300)
                : "competition result");
            const person: PersonObservation = {
              displayName: name,
              identities: [
                {
                  provider: this.kind,
                  externalId: stableHash(page.url, name, affiliation),
                  profileUrl: sourceUrl !== page.url ? sourceUrl : undefined,
                  verified: false,
                },
              ],
              affiliations: affiliation ? [affiliation] : undefined,
              sourceUrl,
            };
            events.push(
              createDiscoveryEvent({
                source: this.kind,
                sourceExternalId: stableHash(page.url, name, eventName, rankText || index),
                type: page.eventType ?? this.defaultEventType,
                title: rankText
                  ? `${name} placed ${rankText} in ${eventName}`
                  : `${name} was recognized in ${eventName}`,
                description: page.descriptionSelector
                  ? sanitizePlainText(item.find(page.descriptionSelector).first().text(), 2_000)
                  : undefined,
                occurredAt: page.dateSelector
                  ? item.find(page.dateSelector).first().attr("datetime") ||
                    item.find(page.dateSelector).first().text()
                  : undefined,
                sourceUrl,
                person,
                metrics: Number.isFinite(rank) && rank > 0 ? { rank: asNumber(rank) } : undefined,
                tags: [page.eventType ?? this.defaultEventType],
                confidence: sourceUrl !== page.url ? 0.78 : 0.68,
                now: context.now,
              }),
            );
          });
      } catch (error) {
        warnings.push(
          `${page.url}: ${error instanceof Error ? error.message : "unknown error"}`,
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
