import * as cheerio from "cheerio";

import {
  crossProfileClaimForUrl,
  extractCrossProfileClaims,
  resolveCrossProfileClaims,
  type CrossProfileClaim,
} from "../cross-profile-links";
import { fetchJson, smartFetch } from "../http";
import { stableHash } from "../idempotency";
import { assertPublicHttpUrl, sanitizePlainText } from "../security";
import type {
  ConnectorEnrichmentContext,
  ConnectorRunResult,
  DiscoveryEvent,
  DiscoveryConnector,
} from "../types";
import { createDiscoveryEvent, mapLimit } from "./shared";

type BraveResult = { url?: string; title?: string; description?: string };
type BraveResponse = { web?: { results?: BraveResult[] } };
type CachedLocator = { expiresAt: number; urls: string[] };
type ProfileLocator = {
  claim: CrossProfileClaim;
  queryHashes: Set<string>;
};
const locatorCache = new Map<string, CachedLocator>();
// Provider-native connectors already collect GitHub, GitLab, and HN evidence
// with stronger identity guarantees. Brave keeps their direct account URLs as
// hypotheses but does not spend the page-verification budget re-fetching their
// repositories or feeds.
const blockedHosts = /(^|\.)(linkedin\.com|x\.com|facebook\.com|instagram\.com|tiktok\.com|github\.com|gitlab\.com|news\.ycombinator\.com)$/i;
const workEvidence = /\b(project|research|paper|preprint|repository|open source|software|system|protocol|compiler|database|robot|biology|physics|mathematics|engineering|benchmark|dataset|competition|olympiad|hackathon|science fair|invention|award|built|published)\b/i;

function redactSensitive(text: string) {
  return sanitizePlainText(text, 3_000)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[contact redacted]")
    .replace(/(?:\+?\d[\d\s().-]{7,}\d)/g, "[contact redacted]");
}

function normalizedWords(value: string) {
  return value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function looksLikeHumanName(value: string) {
  const parts = sanitizePlainText(value, 200).split(/\s+/).filter(Boolean);
  return parts.length >= 2 && parts.length <= 6 && parts.every((part) => /[\p{L}]{2}/u.test(part));
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

function comparableUrl(value: string) {
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return "";
  }
}

export function hasCorroboratedPageIdentity(input: {
  nameMatch: boolean;
  affiliationMatch: boolean;
  matchedProject: boolean;
  linkedKnownProfile: boolean;
  sameKnownWebsite: boolean;
}) {
  return input.matchedProject ||
    input.linkedKnownProfile ||
    (input.nameMatch && input.affiliationMatch) ||
    (input.nameMatch && input.sameKnownWebsite);
}

export function projectLocatorContext(events: DiscoveryEvent[]) {
  const projects = new Map<string, { name: string; url: string; strength: number }>();
  for (const event of events) {
    if (!["project_created", "project_momentum", "open_source_contribution"].includes(event.type)) {
      continue;
    }
    try {
      const url = new URL(event.sourceUrl);
      if (url.hostname.toLowerCase().replace(/^www\./, "") !== "github.com") continue;
      const segments = url.pathname.split("/").filter(Boolean);
      if (segments.length !== 2 || !segments[1] || segments[1].endsWith(".github.io")) continue;
      const normalizedUrl = comparableUrl(event.sourceUrl);
      const strength =
        (event.metrics?.technicalComplexity ?? 0) * 2 +
        Math.log1p(event.metrics?.stars ?? 0) / 5;
      const current = projects.get(normalizedUrl);
      if (!current || strength > current.strength) {
        projects.set(normalizedUrl, {
          name: sanitizePlainText(segments[1], 100),
          url: normalizedUrl,
          strength,
        });
      }
    } catch {
      // Stored evidence can contain legacy URLs; malformed values are ignored.
    }
  }
  return [...projects.values()]
    .sort((left, right) => right.strength - left.strength || left.name.localeCompare(right.name))
    .slice(0, 3)
    .map(({ name, url }) => ({ name, url }));
}

export function candidateResearchQueries(input: {
  person: ConnectorEnrichmentContext["person"];
  events?: DiscoveryEvent[];
  maxQueries: number;
  researchPass?: number;
}) {
  const maxQueries = Math.min(5, Math.max(1, Math.floor(input.maxQueries)));
  const pass = Math.max(0, Math.floor(input.researchPass ?? 0)) % 3;
  const name = input.person.displayName;
  const strongAliases = (input.person.alternateNames ?? [])
    .filter((item) => item.confidence >= 0.72 && looksLikeHumanName(item.name))
    .map((item) => item.name)
    .slice(0, 2);
  const handles = [...new Set(input.person.identities.map((identity) => identity.username).filter(Boolean))]
    .slice(0, 3) as string[];
  const affiliations = (input.person.affiliations ?? []).filter(Boolean).slice(0, 2);
  const known = [...affiliations, ...handles, safeHostname(input.person.websiteUrl)].filter(Boolean) as string[];
  const context = known.slice(0, 2).map((value) => `"${value}"`).join(" ");
  const projects = projectLocatorContext(input.events ?? []);
  const projectQueries = projects.slice(0, 1).map(
    (project) => `"${project.name}" ("${name}" OR ${handles[0] ? `"${handles[0]}"` : `"${name}"`}) -site:github.com`,
  );
  const knownNamesAndHandles = [...new Set([name, ...strongAliases, ...handles])]
    .slice(0, 5)
    .map((value) => `"${value}"`)
    .join(" OR ");
  const linkedInContext = known[0] ? ` "${known[0]}"` : "";
  const linkedInQuery = `"${name}"${linkedInContext} site:linkedin.com/in`;
  const passes = [
    [
      `"${name}" ${context}`.trim(),
      `"${name}" (portfolio OR blog OR projects OR research OR about) -site:linkedin.com`,
      `(${knownNamesAndHandles}) (github OR gitlab OR "Hacker News" OR twitter)`,
      `"${name}" (paper OR preprint OR competition OR hackathon OR olympiad OR "science fair" OR site:openalex.org OR site:semanticscholar.org OR site:arxiv.org OR site:orcid.org)`,
      linkedInQuery,
    ],
    [
      ...projectQueries,
      `"${name}" (built OR launched OR demo OR talk OR podcast OR interview) -site:github.com`,
      `"${name}" (research OR publication OR thesis OR dissertation OR lab OR university)`,
      `"${name}" (award OR finalist OR winner OR fellow OR grant OR startup OR internship)`,
      `"${name}" (open-source OR prototype OR product OR portfolio) -site:github.com`,
      linkedInQuery,
    ],
    [
      `(${knownNamesAndHandles}) (github OR gitlab OR "Hacker News" OR twitter OR linkedin)`,
      `"${name}" ("personal website" OR homepage OR bio OR cv)`,
      `"${name}" (coauthor OR collaborator OR team OR contributor)`,
      `"${name}" ("also known as" OR alias OR username OR site:openreview.net OR site:dblp.org OR site:devpost.com)`,
      linkedInQuery,
    ],
  ];
  const unique = [...new Set(passes[pass].filter(Boolean))];
  if (maxQueries === 1) return unique.slice(0, 1);
  const nonLinkedIn = unique.filter((query) => query !== linkedInQuery).slice(0, maxQueries - 1);
  return [...nonLinkedIn, linkedInQuery];
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
    retries: 1,
    timeoutMs: 8_000,
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
    const maxQueries = Math.min(5, Math.max(1, Number(context.settings.options?.maxQueries ?? 5)));
    const maxResults = Math.min(12, Math.max(1, Number(context.settings.options?.maxResults ?? 8)));
    const knownWebsiteHost = safeHostname(context.person.websiteUrl)?.toLowerCase();
    const projects = projectLocatorContext(context.evidenceEvents ?? []);
    const queries = candidateResearchQueries({
      person: context.person,
      events: context.evidenceEvents,
      maxQueries,
      researchPass: context.researchPass,
    });
    const events = [];
    const warnings: string[] = [];
    const seen = new Set<string>();
    const profileLocators = new Map<string, ProfileLocator>();

    for (const query of queries) {
      let urls: string[];
      try {
        urls = await locate(query, maxResults, context.signal);
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : "Public web lookup failed");
        continue;
      }
      const pagesToVerify: string[] = [];
      for (const locatedUrl of urls.slice(0, maxResults)) {
        try {
          const profileClaim = crossProfileClaimForUrl(locatedUrl);
          if (profileClaim && profileClaim.provider !== "website") {
            const key = `${profileClaim.provider}:${profileClaim.profileUrl}`.toLowerCase();
            const locator = profileLocators.get(key) ?? {
              claim: profileClaim,
              queryHashes: new Set<string>(),
            };
            locator.queryHashes.add(stableHash(query));
            profileLocators.set(key, locator);
            continue;
          }
          const host = new URL(locatedUrl).hostname.toLowerCase();
          if (blockedHosts.test(host) || seen.has(locatedUrl)) continue;
          // Search all returned URLs for direct provider-account locators, but
          // bound expensive HTML verification to the highest-ranked pages.
          if (pagesToVerify.length >= Math.min(6, maxResults)) continue;
          seen.add(locatedUrl);
          pagesToVerify.push(locatedUrl);
        } catch {
          // Result URLs are untrusted locators; malformed URLs are ignored.
        }
      }
      await mapLimit(pagesToVerify, 3, async (locatedUrl) => {
        try {
          const host = new URL(locatedUrl).hostname.toLowerCase();
          const response = await smartFetch(locatedUrl, {
            respectRobots: true,
            signal: context.signal,
            rateLimitPerSecond: 0.2,
            timeoutMs: 8_000,
            retries: 0,
            maxBytes: 2_500_000,
            headers: { accept: "text/html,application/xhtml+xml" },
          });
          if (!response.ok || !(response.headers.get("content-type") ?? "").includes("html")) return;
          const html = await response.text();
          if (/\b(paywall|sign in to continue|members only|private profile)\b/i.test(html.slice(0, 80_000))) return;
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
          const outboundUrls = new Set<string>();
          $("a[href]").each((_, element) => {
            const href = $(element).attr("href");
            if (!href) return;
            const normalized = comparableUrl(new URL(href, canonicalUrl).toString());
            if (normalized) outboundUrls.add(normalized);
          });
          const matchedProject = projects.find((project) => outboundUrls.has(project.url));
          const linkedKnownProfile = context.person.identities.some((identity) => {
            const profileUrl = identity.profileUrl ? comparableUrl(identity.profileUrl) : "";
            return Boolean(profileUrl && outboundUrls.has(profileUrl));
          });
          const name = normalizedWords(context.person.displayName);
          const knownNames = [
            name,
            ...(context.person.alternateNames ?? [])
              .filter((item) => item.confidence >= 0.75)
              .map((item) => normalizedWords(item.name)),
          ].filter((value) => value.length >= 3);
          const affiliations = (context.person.affiliations ?? [])
            .map(normalizedWords)
            .filter((affiliation) => affiliation.length >= 4);
          const authorMatch = Boolean(author && knownNames.includes(normalizedWords(author)));
          const nameMatch = knownNames.some((knownName) => pageText.includes(knownName));
          const affiliationMatch = affiliations.some((affiliation) => pageText.includes(affiliation));
          const sameKnownWebsite = Boolean(
            knownWebsiteHost &&
              (host === knownWebsiteHost ||
                host.endsWith(`.${knownWebsiteHost}`) ||
                knownWebsiteHost.endsWith(`.${host}`)),
          );
          // A matching author meta tag is not identity proof: common names can
          // otherwise bind an unrelated personal site to a candidate. Require
          // a second public anchor such as an affiliation, known account, known
          // project, or an already-verified website domain.
          const identityPresent = hasCorroboratedPageIdentity({
            nameMatch,
            affiliationMatch,
            matchedProject: Boolean(matchedProject),
            linkedKnownProfile,
            sameKnownWebsite,
          });
          if (
            !identityPresent ||
            !title ||
            (!authorMatch && !matchedProject && !linkedKnownProfile && !workEvidence.test(`${title} ${description}`))
          ) {
            return;
          }
          const confidence =
            authorMatch || sameKnownWebsite
              ? 0.86
              : matchedProject
                ? 0.84
                : linkedKnownProfile
                  ? 0.82
                  : 0.68;
          const linkedIdentities = await resolveCrossProfileClaims({
            claims: extractCrossProfileClaims(html, canonicalUrl),
            expectedIdentities: context.person.identities,
            sourceOwned: sameKnownWebsite,
            sourceUrl: canonicalUrl,
            signal: context.signal,
          });
          const observedAuthorAlias = Boolean(
            author &&
            looksLikeHumanName(author) &&
            normalizedWords(author) !== name &&
            (matchedProject || linkedKnownProfile || sameKnownWebsite),
          )
            ? [{
                name: author,
                sourceUrl: canonicalUrl,
                confidence: sameKnownWebsite ? 0.9 : 0.78,
                proof: "owned-page-author" as const,
              }]
            : [];
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
              person: {
                ...context.person,
                identities: [...context.person.identities, ...linkedIdentities],
                alternateNames: [
                  ...(context.person.alternateNames ?? []),
                  ...observedAuthorAlias,
                ],
              },
              tags: [
                "public-web",
                authorMatch
                  ? "authored"
                  : sameKnownWebsite
                    ? "known-domain"
                    : matchedProject
                      ? "linked-project-repository"
                    : linkedKnownProfile
                      ? "linked-provider-profile"
                      : "affiliation-match",
              ],
              raw: {
                locator: "brave-search",
                queryHash: stableHash(query),
                canonicalUrl,
                matchedProjectUrl: matchedProject?.url,
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
      });
    }
    // Search results remain locators, never biographical evidence. A single
    // unambiguous account per provider becomes a reviewable identity hypothesis
    // and a new research input. Durable provider IDs are resolved where a public
    // API allows it, but the account is not auto-bound to the person.
    const byProvider = new Map<string, ProfileLocator[]>();
    for (const locator of profileLocators.values()) {
      const group = byProvider.get(locator.claim.provider) ?? [];
      group.push(locator);
      byProvider.set(locator.claim.provider, group);
    }
    const unambiguousClaims = [...byProvider.values()]
      .filter((group) => group.length === 1)
      .map(([locator]) => locator);
    if (unambiguousClaims.length) {
      const resolved = await resolveCrossProfileClaims({
        claims: unambiguousClaims.map((item) => item.claim),
        expectedIdentities: context.person.identities,
        sourceOwned: false,
        sourceUrl: context.person.sourceUrl,
        signal: context.signal,
      });
      const locatorByProfile = new Map(
        unambiguousClaims.map((item) => [item.claim.profileUrl.toLowerCase(), item]),
      );
      const hypotheses = resolved.map((identity) => {
        const locator = identity.profileUrl
          ? locatorByProfile.get(identity.profileUrl.toLowerCase())
          : undefined;
        const sameKnownHandle = context.person.identities.some(
          (known) => known.username && identity.username &&
            known.username.toLowerCase() === identity.username.toLowerCase(),
        );
        return {
          ...identity,
          verified: false,
          confidence: sameKnownHandle
            ? 0.8
            : (locator?.queryHashes.size ?? 0) >= 2
              ? 0.74
              : 0.6,
          proof: "search-consensus" as const,
          proofSourceUrl: context.person.sourceUrl,
        };
      }).filter((identity) => (identity.confidence ?? 0) >= 0.6);
      if (hypotheses.length) {
        const existing = new Set(
          context.person.identities.map((identity) =>
            `${identity.provider}:${identity.externalId}`.toLowerCase(),
          ),
        );
        const novel = hypotheses.filter(
          (identity) => !existing.has(`${identity.provider}:${identity.externalId}`.toLowerCase()),
        );
        if (novel.length) {
          events.push(createDiscoveryEvent({
            source: "brave-enrichment",
            sourceExternalId: `profile-hypotheses:${stableHash(...novel.map((item) => `${item.provider}:${item.externalId}`))}`,
            type: "profile_observed",
            title: `Potential public accounts located for ${context.person.displayName}`,
            description: "Account URLs are queued for further corroboration and are not treated as verified biographical evidence.",
            occurredAt: context.now.toISOString(),
            sourceUrl: context.person.sourceUrl,
            person: {
              ...context.person,
              identities: [...context.person.identities, ...novel].slice(0, 16),
            },
            tags: ["public-web", "identity-hypothesis", "requires-corroboration"],
            raw: {
              locator: "brave-search",
              profiles: novel.map((identity) => ({
                provider: identity.provider,
                profileUrl: identity.profileUrl,
                confidence: identity.confidence,
                queryCount: identity.profileUrl
                  ? locatorByProfile.get(identity.profileUrl.toLowerCase())?.queryHashes.size ?? 0
                  : 0,
              })),
              snippetStored: false,
            },
            confidence: 0.58,
            now: context.now,
          }));
        }
      }
    }
    return { events, warnings };
  }
}
