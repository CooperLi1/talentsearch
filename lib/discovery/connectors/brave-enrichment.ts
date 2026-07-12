import * as cheerio from "cheerio";

import { fetchJson, smartFetch } from "../http";
import { stableHash } from "../idempotency";
import { assertPublicHttpUrl, sanitizePlainText } from "../security";
import type {
  ConnectorEnrichmentContext,
  ConnectorRunResult,
  DiscoveryConnector,
} from "../types";
import { createDiscoveryEvent } from "./shared";

type BraveResult = { url?: string; title?: string; description?: string };
type BraveResponse = { web?: { results?: BraveResult[] } };
type CachedLocator = { expiresAt: number; urls: string[] };
const locatorCache = new Map<string, CachedLocator>();
const blockedHosts = /(^|\.)(linkedin\.com|x\.com|facebook\.com|instagram\.com|tiktok\.com)$/i;
const workEvidence = /\b(project|research|paper|preprint|repository|open source|software|system|protocol|compiler|database|robot|biology|physics|mathematics|engineering|benchmark|dataset|competition|olympiad|hackathon|science fair|invention|award|built|published)\b/i;

function redactSensitive(text: string) {
  return sanitizePlainText(text, 3_000)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[contact redacted]")
    .replace(/(?:\+?\d[\d\s().-]{7,}\d)/g, "[contact redacted]");
}

function normalizedWords(value: string) {
  return value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function safeHostname(value?: string) {
  if (!value) return undefined;
  try {
    return new URL(value).hostname;
  } catch {
    return undefined;
  }
}

function normalizeLocator(value: string) {
  try {
    const url = new URL(value);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|ref$)/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return "";
  }
}

async function locate(query: string, count: number, signal?: AbortSignal) {
  const key = stableHash(query, count);
  const cached = locatorCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.urls;
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(Math.min(20, count)));
  url.searchParams.set("safesearch", "strict");
  url.searchParams.set("text_decorations", "false");
  const response = await fetchJson<BraveResponse>(url.toString(), {
    headers: {
      accept: "application/json",
      "x-subscription-token": process.env.BRAVE_SEARCH_API_KEY!,
    },
    signal,
    rateLimitPerSecond: 0.5,
    maxBytes: 1_500_000,
  });
  // Brave content is only a transient locator. Only normalized result URLs survive this function.
  const urls = [
    ...new Set(
      (response.web?.results ?? [])
        .map((result) => normalizeLocator(result.url ?? ""))
        .filter(Boolean),
    ),
  ];
  locatorCache.set(key, { expiresAt: Date.now() + 24 * 60 * 60 * 1_000, urls });
  return urls;
}

export class BraveEnrichmentConnector implements DiscoveryConnector {
  readonly kind = "brave-enrichment" as const;
  readonly displayName = "Public web enrichment";

  async discover(): Promise<ConnectorRunResult> {
    return { events: [], warnings: ["Public web enrichment runs only after a candidate exists."] };
  }

  async enrich(context: ConnectorEnrichmentContext): Promise<ConnectorRunResult | null> {
    if (!process.env.BRAVE_SEARCH_API_KEY) return null;
    const maxQueries = Math.min(2, Math.max(1, Number(context.settings.options?.maxQueries ?? 2)));
    const maxResults = Math.min(8, Math.max(1, Number(context.settings.options?.maxResults ?? 5)));
    const knownWebsiteHost = safeHostname(context.person.websiteUrl)?.toLowerCase();
    const known = [
      context.person.affiliations?.[0],
      context.person.identities.find((identity) => identity.username)?.username,
      safeHostname(context.person.websiteUrl),
    ].filter(Boolean);
    const queries = [
      `"${context.person.displayName}" ${known.slice(0, 2).join(" ")}`,
      `"${context.person.displayName}" (project OR research OR competition OR github)`,
    ].slice(0, maxQueries);
    const events = [];
    const warnings: string[] = [];
    const seen = new Set<string>();

    for (const query of queries) {
      let urls: string[];
      try {
        urls = await locate(query, maxResults, context.signal);
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : "Public web lookup failed");
        continue;
      }
      for (const locatedUrl of urls.slice(0, maxResults)) {
        try {
          const host = new URL(locatedUrl).hostname.toLowerCase();
          if (blockedHosts.test(host) || seen.has(locatedUrl)) continue;
          seen.add(locatedUrl);
          const response = await smartFetch(locatedUrl, {
            respectRobots: true,
            signal: context.signal,
            rateLimitPerSecond: 0.2,
            timeoutMs: 12_000,
            maxBytes: 2_500_000,
            headers: { accept: "text/html,application/xhtml+xml" },
          });
          if (!response.ok || !(response.headers.get("content-type") ?? "").includes("html")) continue;
          const html = await response.text();
          if (/\b(paywall|sign in to continue|members only|private profile)\b/i.test(html.slice(0, 80_000))) continue;
          const $ = cheerio.load(html);
          $("script:not([type='application/ld+json']),style,noscript,form,input,button").remove();
          const canonicalRaw = $('link[rel="canonical"]').attr("href");
          let canonicalUrl = locatedUrl;
          if (canonicalRaw) {
            try {
              const proposed = await assertPublicHttpUrl(new URL(canonicalRaw, locatedUrl).toString());
              if (proposed.origin === new URL(locatedUrl).origin) canonicalUrl = normalizeLocator(proposed.toString());
            } catch {
              canonicalUrl = locatedUrl;
            }
          }
          const title = sanitizePlainText($('meta[property="og:title"]').attr("content") || $("title").text(), 500);
          const author = sanitizePlainText($('meta[name="author"]').attr("content"), 200);
          const description = redactSensitive(
            $('meta[name="description"]').attr("content") || $("article,main").first().text().slice(0, 3_000),
          );
          const pageText = normalizedWords(`${title} ${author} ${$("article,main").first().text().slice(0, 20_000)}`);
          const name = normalizedWords(context.person.displayName);
          const handles = context.person.identities
            .map((identity) => normalizedWords(identity.username ?? ""))
            .filter((handle) => handle.length >= 3);
          const affiliations = (context.person.affiliations ?? [])
            .map(normalizedWords)
            .filter((affiliation) => affiliation.length >= 4);
          const authorMatch = Boolean(author && normalizedWords(author) === name);
          const nameMatch = name.length >= 3 && pageText.includes(name);
          const handleMatch = handles.some((handle) => pageText.includes(handle));
          const affiliationMatch = affiliations.some((affiliation) => pageText.includes(affiliation));
          const sameKnownWebsite = Boolean(
            knownWebsiteHost &&
              (host === knownWebsiteHost ||
                host.endsWith(`.${knownWebsiteHost}`) ||
                knownWebsiteHost.endsWith(`.${host}`)),
          );
          const identityPresent =
            authorMatch ||
            handleMatch ||
            (nameMatch && affiliationMatch) ||
            (nameMatch && sameKnownWebsite);
          if (!identityPresent || !title || (!authorMatch && !workEvidence.test(`${title} ${description}`))) {
            continue;
          }
          const confidence =
            authorMatch || sameKnownWebsite ? 0.86 : handleMatch ? 0.78 : 0.68;
          events.push(
            createDiscoveryEvent({
              source: "brave-enrichment",
              sourceExternalId: stableHash(canonicalUrl, context.person.displayName),
              type: "other",
              title: authorMatch
                ? `${context.person.displayName} published “${title}”`
                : `${context.person.displayName} appears in “${title}”`,
              description: description || undefined,
              occurredAt:
                $('meta[property="article:published_time"]').attr("content") ||
                $("time[datetime]").first().attr("datetime"),
              sourceUrl: canonicalUrl,
              person: context.person,
              tags: [
                "public-web",
                authorMatch
                  ? "authored"
                  : sameKnownWebsite
                    ? "known-domain"
                    : handleMatch
                      ? "handle-match"
                      : "affiliation-match",
              ],
              raw: {
                locator: "brave-search",
                queryHash: stableHash(query),
                canonicalUrl,
                retrievedAt: context.now.toISOString(),
                contentHash: stableHash(title, description, pageText.slice(0, 10_000)),
                snippetStored: false,
              },
              confidence,
              now: context.now,
            }),
          );
        } catch {
          // Result URLs are untrusted locators; one unsafe or unavailable page never aborts enrichment.
        }
      }
    }
    return { events, warnings };
  }
}
