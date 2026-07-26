import * as cheerio from "cheerio";

import { smartFetch } from "../http";
import { stableHash } from "../idempotency";
import { assertPublicHttpUrl, sanitizePlainText } from "../security";
import type {
  ConnectorRunContext,
  ConnectorRunResult,
  DiscoveryConnector,
  DiscoveryEvent,
  PersonObservation,
} from "../types";
import {
  asNumber,
  createDiscoveryEvent,
} from "./shared";

export type RosterPerson = {
  affiliation?: string;
  name: string;
  profileUrl?: string;
  rank?: number;
  recognition?: string;
  rowText: string;
};

const PROFILE_PATH =
  /\/(?:people|person|contestants?|participants?|profiles?|members?|students?|winners?)\//iu;
const RESERVED_PROFILE_PATH =
  /\/(?:search|results?|rankings?|countries|tasks?|login|add|new|index)\/?$/iu;
const EXCLUDED_NAME =
  /^(?:results?|contestants?|participants?|delegations?|countries|tasks?|rank|score|award|gold|silver|bronze|honou?rable mention|login|search|home|main)$/iu;
const RECOGNITION =
  /\b(gold|silver|bronze|honou?rable mention|winner|finalist)\b/iu;

function clean(value: string, maximum = 300) {
  return sanitizePlainText(value, maximum).replace(/\s+/gu, " ").trim();
}

function looksLikeHumanName(value: string) {
  const name = clean(value, 200);
  const parts = name.split(/\s+/u);
  return (
    !EXCLUDED_NAME.test(name) &&
    parts.length >= 2 &&
    parts.length <= 7 &&
    parts.every(
      (part) =>
        /^[\p{L}][\p{L}\p{M}'’.-]{0,49}$/u.test(part) &&
        !/^(?:the|and|team|country|score)$/iu.test(part),
    )
  );
}

function looksLikeProfilePath(value: string) {
  try {
    const pathname = new URL(value, "https://roster.invalid").pathname;
    return PROFILE_PATH.test(pathname) && !RESERVED_PROFILE_PATH.test(pathname);
  } catch {
    return false;
  }
}

function absoluteUrl(value: string | undefined, pageUrl: string) {
  if (!value) return undefined;
  try {
    const resolved = new URL(value, pageUrl);
    return ["http:", "https:"].includes(resolved.protocol)
      ? resolved.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function rowRank(value: string) {
  const match = clean(value, 80).match(
    /^(?:rank\s*)?(?:#\s*)?(\d{1,5})(?:st|nd|rd|th)?\b/iu,
  );
  const rank = Number(match?.[1]);
  return Number.isSafeInteger(rank) && rank > 0 ? rank : undefined;
}

export function extractRosterPeople(html: string, pageUrl: string): RosterPerson[] {
  const $ = cheerio.load(html);
  const documentBase =
    absoluteUrl($("base[href]").first().attr("href"), pageUrl) ?? pageUrl;
  const found = new Map<string, RosterPerson>();

  const add = (input: RosterPerson) => {
    if (!looksLikeHumanName(input.name)) return;
    const key = `${clean(input.name).toLocaleLowerCase("en-US")}:${(
      input.profileUrl ?? ""
    ).toLocaleLowerCase("en-US")}`;
    if (!found.has(key)) found.set(key, input);
  };

  $("table tr").each((_index, element) => {
    const row = $(element);
    const rowText = clean(row.text(), 2_000);
    if (!rowText) return;
    const anchors = row.find("a[href]").toArray();
    const personAnchor =
      anchors.find((anchor) => {
        const href = $(anchor).attr("href") ?? "";
        return looksLikeProfilePath(href) && looksLikeHumanName($(anchor).text());
      }) ??
      anchors.find((anchor) => looksLikeHumanName($(anchor).text()));
    const namedCell = row
      .find(
        "[itemprop='name'],[class*='contestant'],[class*='participant'],[class~='name']",
      )
      .toArray()
      .find((cell) => looksLikeHumanName($(cell).text()));
    const name = clean(
      personAnchor ? $(personAnchor).text() : namedCell ? $(namedCell).text() : "",
      200,
    );
    if (!name) return;
    const countryAnchor = anchors.find((anchor) =>
      /(?:^|\/)(?:countries|delegations|schools?|organizations?)\//iu.test(
        $(anchor).attr("href") ?? "",
      ),
    );
    const affiliation = clean(
      countryAnchor
        ? $(countryAnchor).text()
        : row
            .find(
              "[class*='country'],[class*='school'],[class*='affiliation'],[itemprop='affiliation']",
            )
            .first()
            .text(),
      300,
    );
    add({
      name,
      profileUrl: absoluteUrl(
        personAnchor ? $(personAnchor).attr("href") : undefined,
        documentBase,
      ),
      affiliation: affiliation || undefined,
      rank: rowRank(row.find("th,td").first().text()) ?? rowRank(rowText),
      recognition: clean(rowText.match(RECOGNITION)?.[1] ?? "", 100) || undefined,
      rowText,
    });
  });

  $("a[href]").each((_index, element) => {
    const anchor = $(element);
    const href = anchor.attr("href") ?? "";
    const name = clean(anchor.text(), 200);
    if (!looksLikeProfilePath(href) || !looksLikeHumanName(name)) return;
    const container = anchor.closest("li,article,[class*='card'],[class*='result']");
    const rowText = clean(container.length ? container.text() : name, 2_000);
    add({
      name,
      profileUrl: absoluteUrl(href, documentBase),
      rank: rowRank(rowText),
      recognition: clean(rowText.match(RECOGNITION)?.[1] ?? "", 100) || undefined,
      rowText,
    });
  });

  return [...found.values()];
}

function pageYear(pageUrl: string, pageTitle: string) {
  const match = `${pageUrl} ${pageTitle}`.match(/\b(20\d{2}|19\d{2})\b/u);
  return match ? `${match[1]}-01-01T00:00:00.000Z` : undefined;
}

function recognitionTitle(person: RosterPerson, eventName: string) {
  if (person.recognition) {
    return `${person.name} received ${person.recognition.toLocaleLowerCase(
      "en-US",
    )} recognition at ${eventName}`;
  }
  if (person.rank) return `${person.name} placed ${person.rank} at ${eventName}`;
  return `${person.name} was listed at ${eventName}`;
}

export class RosterPageConnector implements DiscoveryConnector {
  readonly kind = "roster-page" as const;
  readonly displayName = "Manual roster-page deep dive";

  async discover(context: ConnectorRunContext): Promise<ConnectorRunResult> {
    const urls = (context.settings.urls ?? []).slice(0, 3);
    const maximum = Math.min(500, Math.max(1, context.settings.maxItems ?? 500));
    const configuredOffset = Number(context.settings.options?.offset ?? 0);
    const offset =
      Number.isSafeInteger(configuredOffset) && configuredOffset > 0
        ? Math.min(499, configuredOffset)
        : 0;
    const events: DiscoveryEvent[] = [];
    const warnings: string[] = [];

    for (const rawUrl of urls) {
      try {
        const pageUrl = (await assertPublicHttpUrl(rawUrl)).toString();
        const response = await smartFetch(pageUrl, {
          respectRobots: true,
          signal: context.signal,
          rateLimitPerSecond: 0.2,
          timeoutMs: 20_000,
          maxBytes: 6_000_000,
          headers: { accept: "text/html,application/xhtml+xml" },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const html = await response.text();
        const $ = cheerio.load(html);
        const eventName =
          clean($("h1").first().text(), 200) ||
          clean($("title").text(), 200) ||
          new URL(pageUrl).hostname;
        const remaining = Math.max(0, maximum - events.length);
        const people = extractRosterPeople(html, pageUrl).slice(
          offset,
          offset + remaining,
        );
        const occurredAt = pageYear(pageUrl, eventName);
        for (const rosterPerson of people) {
          const person: PersonObservation = {
            displayName: rosterPerson.name,
            identities: [
              {
                provider: "roster-page",
                externalId: stableHash(
                  pageUrl,
                  rosterPerson.profileUrl ?? rosterPerson.name,
                ),
                profileUrl: rosterPerson.profileUrl,
                verified: false,
              },
            ],
            affiliations: rosterPerson.affiliation
              ? [rosterPerson.affiliation]
              : undefined,
            sourceUrl: rosterPerson.profileUrl ?? pageUrl,
          };
          events.push(
            createDiscoveryEvent({
              source: "roster-page",
              sourceExternalId: stableHash(
                pageUrl,
                rosterPerson.profileUrl ?? rosterPerson.name,
                rosterPerson.rank,
              ),
              type: "community_recognition",
              title: recognitionTitle(rosterPerson, eventName),
              description: rosterPerson.rowText,
              occurredAt,
              sourceUrl: rosterPerson.profileUrl ?? pageUrl,
              person,
              metrics: rosterPerson.rank
                ? { rank: asNumber(rosterPerson.rank) }
                : undefined,
              tags: [
                "manual-roster-deep-dive",
                ...(rosterPerson.recognition
                  ? [
                      rosterPerson.recognition
                        .toLocaleLowerCase("en-US")
                        .replace(/\s+/gu, "-"),
                    ]
                  : []),
              ],
              raw: {
                rosterPageUrl: pageUrl,
                rosterEventName: eventName,
                rowText: rosterPerson.rowText,
              },
              confidence: rosterPerson.profileUrl ? 0.82 : 0.7,
              now: context.now,
            }),
          );
        }
        if (!people.length) {
          warnings.push(`${pageUrl}: no human-name roster rows were found`);
        }
      } catch (error) {
        warnings.push(
          `${rawUrl}: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
      }
      if (events.length >= maximum) break;
    }

    return {
      events: events.slice(0, maximum),
      cursor: { completedAt: context.now.toISOString() },
      warnings,
    };
  }
}
