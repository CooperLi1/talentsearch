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

type RosterDocument = {
  contents: string;
  eventName: string;
  format: "html" | "text";
  retrievalMode: "direct" | "exa-cache";
};

type ExaContentsResult = {
  title?: unknown;
  text?: unknown;
  url?: unknown;
};

type ExaContentsStatus = {
  error?: unknown;
  status?: unknown;
  url?: unknown;
};

type ExaContentsResponse = {
  results?: unknown;
  statuses?: unknown;
};

const EXA_CONTENTS_ENDPOINT = "https://api.exa.ai/contents";

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

function markdownCells(line: string) {
  const trimmed = line.trim().replace(/^\|/u, "").replace(/\|$/u, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function cachedDocumentText(value: unknown, maximum = 500_000) {
  if (typeof value !== "string") return "";
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, " ")
    .slice(0, maximum)
    .trim();
}

function markdownCellText(cell: string) {
  return clean(
    cell
      .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
      .replace(/[*_`]/gu, ""),
    500,
  );
}

function markdownCellLink(cell: string, pageUrl: string) {
  const match = cell.match(/\[[^\]]+\]\(([^\s)]+)(?:\s+"[^"]*")?\)/u);
  return absoluteUrl(match?.[1], pageUrl);
}

function isMarkdownSeparator(cells: string[]) {
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/u.test(cell));
}

export function extractRosterPeopleFromText(
  text: string,
  pageUrl: string,
): RosterPerson[] {
  const found = new Map<string, RosterPerson>();
  let headers: string[] = [];

  for (const line of text.split(/\r?\n/u)) {
    if (!line.includes("|")) continue;
    const cells = markdownCells(line);
    if (cells.length < 2 || isMarkdownSeparator(cells)) continue;
    const plainCells = cells.map(markdownCellText);
    const normalized = plainCells.map((cell) => cell.toLocaleLowerCase("en-US"));
    const possibleNameHeader = normalized.findIndex((cell) =>
      /^(?:contestant|participant|student|winner|name)$/u.test(cell),
    );
    if (possibleNameHeader >= 0) {
      headers = normalized;
      continue;
    }

    const nameIndex = headers.findIndex((cell) =>
      /^(?:contestant|participant|student|winner|name)$/u.test(cell),
    );
    if (nameIndex < 0 || nameIndex >= plainCells.length) continue;
    const name = clean(plainCells[nameIndex], 200);
    if (!looksLikeHumanName(name)) continue;
    const affiliationIndex = headers.findIndex((cell) =>
      /^(?:country|school|affiliation|organization|institution|team)$/u.test(cell),
    );
    const rankIndex = headers.findIndex((cell) => /^(?:rank|place|position)$/u.test(cell));
    const rowText = clean(plainCells.join(" | "), 2_000);
    const profileUrl = markdownCellLink(cells[nameIndex], pageUrl);
    const affiliation =
      affiliationIndex >= 0 && affiliationIndex < plainCells.length
        ? clean(plainCells[affiliationIndex], 300)
        : "";
    const rank =
      rankIndex >= 0 && rankIndex < plainCells.length
        ? rowRank(plainCells[rankIndex])
        : rowRank(plainCells[0]);
    const recognition = clean(rowText.match(RECOGNITION)?.[1] ?? "", 100);
    const key = `${name.toLocaleLowerCase("en-US")}:${(
      profileUrl ?? ""
    ).toLocaleLowerCase("en-US")}`;
    if (!found.has(key)) {
      found.set(key, {
        name,
        profileUrl,
        affiliation: affiliation || undefined,
        rank,
        recognition: recognition || undefined,
        rowText,
      });
    }
  }

  return [...found.values()];
}

function robotsDisallowed(error: unknown) {
  return error instanceof Error && /robots\.txt disallows/iu.test(error.message);
}

async function fetchExaCachedRoster(
  pageUrl: string,
  signal?: AbortSignal,
): Promise<RosterDocument> {
  const apiKey = process.env.EXA_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "robots.txt blocks direct access and EXA_API_KEY is not configured for the cache-only fallback",
    );
  }
  const response = await smartFetch(EXA_CONTENTS_ENDPOINT, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({
      urls: [pageUrl],
      text: { maxCharacters: 150_000 },
      // Never ask Exa to crawl a page whose publisher disallows our direct fetch.
      maxAgeHours: -1,
    }),
    rateLimitPerSecond: 1,
    timeoutMs: 20_000,
    retries: 1,
    maxBytes: 6_000_000,
    signal,
  });
  if (!response.ok) throw new Error(`Exa cache lookup returned HTTP ${response.status}`);
  const payload = (await response.json()) as ExaContentsResponse;
  const results = Array.isArray(payload.results)
    ? payload.results.filter(
        (value): value is ExaContentsResult => Boolean(value && typeof value === "object"),
      )
    : [];
  const result = results.find(
    (item) => sanitizePlainText(item.url, 2_000) === pageUrl,
  ) ?? results[0];
  const contents = cachedDocumentText(result?.text);
  if (!contents) {
    const statuses = Array.isArray(payload.statuses)
      ? payload.statuses.filter(
          (value): value is ExaContentsStatus => Boolean(value && typeof value === "object"),
        )
      : [];
    const status = statuses.find(
      (item) => sanitizePlainText(item.url, 2_000) === pageUrl,
    ) ?? statuses[0];
    const detail = sanitizePlainText(status?.error || status?.status, 300);
    throw new Error(
      `no cached page copy is available from Exa${detail ? ` (${detail})` : ""}`,
    );
  }
  return {
    contents,
    eventName:
      sanitizePlainText(result?.title, 200) ||
      new URL(pageUrl).hostname,
    format: "text",
    retrievalMode: "exa-cache",
  };
}

async function fetchRosterDocument(
  pageUrl: string,
  signal?: AbortSignal,
): Promise<RosterDocument> {
  try {
    const response = await smartFetch(pageUrl, {
      respectRobots: true,
      signal,
      rateLimitPerSecond: 0.2,
      timeoutMs: 20_000,
      maxBytes: 6_000_000,
      headers: { accept: "text/html,application/xhtml+xml" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contents = await response.text();
    const $ = cheerio.load(contents);
    return {
      contents,
      eventName:
        clean($("h1").first().text(), 200) ||
        clean($("title").text(), 200) ||
        new URL(pageUrl).hostname,
      format: "html",
      retrievalMode: "direct",
    };
  } catch (error) {
    if (!robotsDisallowed(error)) throw error;
    return fetchExaCachedRoster(pageUrl, signal);
  }
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
        const document = await fetchRosterDocument(pageUrl, context.signal);
        const eventName = document.eventName;
        const remaining = Math.max(0, maximum - events.length);
        const people = (document.format === "html"
          ? extractRosterPeople(document.contents, pageUrl)
          : extractRosterPeopleFromText(document.contents, pageUrl)
        ).slice(offset, offset + remaining);
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
              type:
                rosterPerson.rank || rosterPerson.recognition
                  ? "competition_result"
                  : "community_recognition",
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
                ...(document.retrievalMode === "exa-cache"
                  ? ["exa-cache-only"]
                  : []),
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
                retrievalMode: document.retrievalMode,
                rowText: rosterPerson.rowText,
              },
              confidence:
                document.retrievalMode === "exa-cache"
                  ? rosterPerson.profileUrl
                    ? 0.78
                    : 0.66
                  : rosterPerson.profileUrl
                    ? 0.82
                    : 0.7,
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
