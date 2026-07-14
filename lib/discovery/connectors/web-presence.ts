import * as cheerio from "cheerio";
import { XMLParser } from "fast-xml-parser";
import { isIP } from "node:net";

import { normalizeContactRoutes } from "@/lib/contact/routes";
import type { CandidateContactRoute } from "@/lib/domain/types";

import { discoverCrossProfileIdentitiesFromHtml } from "../cross-profile-links";
import { smartFetch } from "../http";
import { stableHash } from "../idempotency";
import { normalizeLinkedInMemberUrl } from "../linkedin-policy";
import { assertPublicHttpUrl, isBlockedIp, sanitizePlainText } from "../security";
import type {
  ConnectorEnrichmentContext,
  ConnectorRunContext,
  ConnectorRunResult,
  DiscoveryConnector,
  DiscoveryEvent,
  ExternalIdentity,
  PersonObservation,
} from "../types";
import { createDiscoveryEvent, mapLimit } from "./shared";
import { FeedConnector } from "./feed";

type JsonLd = Record<string, unknown>;

const ACCESS_GATE = /\b(sign in to continue|log in to continue|members only|private (?:page|profile)|access denied|authentication required)\b/i;

function redactSensitive(value: unknown, maxLength = 3_000) {
  return sanitizePlainText(value, maxLength)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[contact redacted]")
    .replace(/(?:\+?\d[\d\s().-]{7,}\d)/g, "[contact redacted]");
}

export function ownedWorkProfileFromHtml(html: string) {
  const $ = cheerio.load(html);
  const title = sanitizePlainText(
    $('meta[property="og:title"]').attr("content") || $("title").text(),
    300,
  );
  const description = redactSensitive(
    [
      $('meta[name="description"]').attr("content"),
      $("main").first().text().slice(0, 3_000),
    ].filter(Boolean).join(" "),
    3_000,
  );
  const explicitRole = description.match(
    /\b((?:incoming\s+)?(?:direct\s+)?(?:ph\.?d\.?|doctoral|graduate|undergraduate)\s+student\s+at\s+[A-Z][\p{L}&.' -]{1,100}?(?:University|Institute|Laboratory|Lab|College|School))\b/iu,
  )?.[1];
  const profileHeadline = explicitRole || description
    .split(/(?<=[.!?])\s+/)
    .find((sentence) =>
      sentence.length <= 240 &&
      /\b(?:ph\.?d\.?|doctoral|graduate student|undergraduate|researcher|engineer|founder|student at|works? at)\b/i.test(sentence),
    );
  const affiliations = [...description.matchAll(
    /\b(?:at|with)\s+([A-Z][\p{L}&.' -]{1,100}?(?:University|Institute|Laboratory|Lab|College|School))\b/gu,
  )]
    .map((match) => sanitizePlainText(match[1], 200))
    .filter(Boolean)
    .slice(0, 6);
  return title && description
    ? {
        title,
        description,
        profileHeadline: profileHeadline ? sanitizePlainText(profileHeadline, 500) : undefined,
        affiliations: [...new Set(affiliations)],
        contentHash: stableHash(title, description),
      }
    : null;
}

function normalizedName(value: unknown) {
  return sanitizePlainText(value, 200)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function safeHttpUrl(value: unknown, base?: string): URL | null {
  try {
    const url = new URL(String(value ?? ""), base);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    const hostname = url.hostname.replace(/\.$/, "").toLowerCase();
    const ipHostname = hostname.replace(/^\[|\]$/g, "");
    if (
      !hostname ||
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal") ||
      (isIP(ipHostname) > 0 && isBlockedIp(ipHostname))
    ) return null;
    url.hostname = hostname;
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

function isSameOrigin(value: string, knownWebsite: string) {
  const observed = safeHttpUrl(value);
  const known = safeHttpUrl(knownWebsite);
  return Boolean(observed && known && observed.origin === known.origin);
}

function isAcademicHostname(hostname: string) {
  return /(?:\.edu|\.ac\.[a-z]{2}|\.edu\.[a-z]{2})$/i.test(hostname);
}

export function publicContactRoutesFromHtml(
  html: string,
  pageUrl: string,
  stage?: string,
): CandidateContactRoute[] {
  const $ = cheerio.load(html);
  const routes: CandidateContactRoute[] = [];
  $("a[href]").each((_, element) => {
    const href = String($(element).attr("href") ?? "").trim();
    const label = sanitizePlainText($(element).text(), 80);
    if (/^mailto:/i.test(href)) {
      routes.push({
        kind: "email",
        label: "Public email",
        url: href.split("?")[0],
        provenanceUrl: pageUrl,
        confidence: 0.96,
        verified: true,
        audience: "direct",
      });
      return;
    }
    const target = safeHttpUrl(href, pageUrl);
    if (!target) return;
    const isContact =
      /\b(contact|get in touch|reach me)\b/i.test(label) ||
      /\/(?:contact|contact-me|get-in-touch)\/?$/i.test(target.pathname);
    const isInstitutional =
      isAcademicHostname(target.hostname) &&
      /\b(lab|department|university|school|faculty|research group)\b/i.test(label);
    if (isInstitutional) {
      routes.push({
        kind: "institutional",
        label: label || "Institutional profile",
        url: target.toString(),
        provenanceUrl: pageUrl,
        confidence: 0.9,
        verified: true,
        audience: "institutional",
      });
    } else if (isContact && isSameOrigin(target.toString(), pageUrl)) {
      routes.push({
        kind: "contact-page",
        label: label || "Contact page",
        url: target.toString(),
        provenanceUrl: pageUrl,
        confidence: 0.92,
        verified: true,
        audience: "direct",
      });
    }
  });
  return normalizeContactRoutes(routes, stage);
}

function list<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function jsonLdNodes(value: unknown): JsonLd[] {
  if (Array.isArray(value)) return value.flatMap(jsonLdNodes);
  if (!value || typeof value !== "object") return [];
  const record = value as JsonLd;
  return [record, ...jsonLdNodes(record["@graph"])];
}

function typeNames(node: JsonLd) {
  return list(node["@type"] as string | string[] | undefined).map((value) =>
    String(value).toLowerCase(),
  );
}

function authorName(value: unknown): string {
  if (typeof value === "string") return sanitizePlainText(value, 200);
  if (Array.isArray(value)) {
    return value.map(authorName).filter(Boolean).join(", ").slice(0, 200);
  }
  if (value && typeof value === "object") {
    const record = value as JsonLd;
    return sanitizePlainText(record.name, 200);
  }
  return "";
}

function nodeUrl(node: JsonLd, fallback: string) {
  const raw = typeof node.url === "string" ? node.url : fallback;
  return safeHttpUrl(raw, fallback)?.toString() ?? fallback;
}

function identityFor(author: string, profileUrl: string, sameAs?: unknown): ExternalIdentity[] {
  const identities: ExternalIdentity[] = [
    {
      provider: "web-presence",
      externalId: stableHash(new URL(profileUrl).origin, author),
      profileUrl,
      verified: false,
    },
  ];
  for (const url of list(sameAs as string | string[] | undefined).slice(0, 10)) {
    const normalized = safeHttpUrl(url);
    if (!normalized) continue;
    const linkedInProfileUrl = normalizeLinkedInMemberUrl(normalized.toString());
    if (linkedInProfileUrl) {
      identities.push({
        provider: "linkedin-manual",
        externalId: stableHash(linkedInProfileUrl),
        profileUrl: linkedInProfileUrl,
        username: new URL(linkedInProfileUrl).pathname.split("/").filter(Boolean).at(-1),
        verified: false,
      });
      continue;
    }
    identities.push({
      provider: "website",
      externalId: stableHash(normalized.toString()),
      profileUrl: normalized.toString(),
      verified: false,
    });
  }
  return identities;
}

function alternateNamesFor(node: JsonLd | undefined, sourceUrl: string, canonicalName: string) {
  const canonical = normalizedName(canonicalName);
  return list(node?.alternateName as string | string[] | undefined)
    .map((value) => sanitizePlainText(value, 200))
    .filter((value) => value && normalizedName(value) !== canonical)
    .slice(0, 12)
    .map((name) => ({
      name,
      sourceUrl,
      confidence: 0.9,
      proof: "jsonld-alternate-name" as const,
    }));
}

function eventsFromHtml(html: string, pageUrl: string, now: Date): DiscoveryEvent[] {
  const $ = cheerio.load(html);
  const nodes: JsonLd[] = [];
  $('script[type="application/ld+json"]').each((_, element) => {
    const text = $(element).text().slice(0, 200_000);
    try {
      nodes.push(...jsonLdNodes(JSON.parse(text)));
    } catch {
      // Invalid page-authored JSON-LD is ignored, never evaluated.
    }
  });
  const personNode = nodes.find((node) => typeNames(node).includes("person"));
  const personName = authorName(personNode?.name);
  const profileUrl = personNode ? nodeUrl(personNode, pageUrl) : pageUrl;
  const alternateNames = alternateNamesFor(personNode, profileUrl, personName);
  const events: DiscoveryEvent[] = [];

  for (const node of nodes.slice(0, 80)) {
    const types = typeNames(node);
    const isArticle = types.some((type) =>
      ["article", "blogposting", "techarticle", "scholarlyarticle"].includes(type),
    );
    const isProject = types.some((type) =>
      ["softwaresourcecode", "softwareapplication", "creativework", "product"].includes(type),
    );
    if (!isArticle && !isProject) continue;
    const author = authorName(node.author ?? node.creator) || personName;
    const title = sanitizePlainText(node.headline ?? node.name, 500);
    if (!author || !title) continue;
    const sourceUrl = nodeUrl(node, pageUrl);
    const person: PersonObservation = {
      displayName: author,
      identities: identityFor(author, profileUrl, personNode?.sameAs),
      alternateNames,
      headline: personNode ? redactSensitive(personNode.description, 500) || undefined : undefined,
      biography: personNode ? redactSensitive(personNode.description, 2_000) || undefined : undefined,
      sourceUrl: profileUrl,
    };
    events.push(
      createDiscoveryEvent({
        source: "web-presence",
        sourceExternalId: sanitizePlainText(node["@id"], 500) || stableHash(sourceUrl, title),
        type: isProject ? "project_created" : "community_recognition",
        title: isProject ? `${author} published ${title}` : `${author} wrote “${title}”`,
        description: redactSensitive(node.description ?? node.abstract, 3_000) || undefined,
        occurredAt: node.datePublished ?? node.dateModified,
        sourceUrl,
        person,
        tags: isProject ? ["personal-project", "json-ld"] : ["technical-writing", "json-ld"],
        confidence: personNode ? 0.82 : 0.68,
        now,
      }),
    );
  }

  if (!events.length) {
    const author =
      sanitizePlainText($('meta[name="author"]').attr("content"), 200) || personName;
    const title =
      sanitizePlainText($('meta[property="og:title"]').attr("content"), 500) ||
      sanitizePlainText($("title").text(), 500);
    const published =
      $('meta[property="article:published_time"]').attr("content") ||
      $("time[datetime]").first().attr("datetime");
    if (author && title && published) {
      const person: PersonObservation = {
        displayName: author,
        identities: identityFor(author, profileUrl, personNode?.sameAs),
        alternateNames,
        sourceUrl: profileUrl,
      };
      events.push(
        createDiscoveryEvent({
          source: "web-presence",
          sourceExternalId: stableHash(pageUrl, title),
          type: "community_recognition",
          title: `${author} wrote “${title}”`,
          description:
            redactSensitive($('meta[name="description"]').attr("content"), 2_000) || undefined,
          occurredAt: published,
          sourceUrl: pageUrl,
          person,
          tags: ["personal-site"],
          confidence: personNode ? 0.75 : 0.58,
          now,
        }),
      );
    }
  }

  if (personNode && personName) {
    const person: PersonObservation = {
      displayName: personName,
      identities: identityFor(personName, profileUrl, personNode.sameAs),
      alternateNames,
      headline: redactSensitive(personNode.jobTitle ?? personNode.description, 500) || undefined,
      biography: redactSensitive(personNode.description, 2_000) || undefined,
      sourceUrl: profileUrl,
    };
    events.push(
      createDiscoveryEvent({
        source: "web-presence",
        sourceExternalId: `person:${stableHash(profileUrl, personName)}`,
        type: "profile_observed",
        title: `${personName}'s personal site`,
        description: person.biography,
        sourceUrl: profileUrl,
        person,
        tags: ["personal-site", "json-ld"],
        confidence: 0.78,
        now,
      }),
    );
  }
  return events;
}

function redactEvent(event: DiscoveryEvent): DiscoveryEvent {
  return {
    ...event,
    title: redactSensitive(event.title, 500),
    description: event.description ? redactSensitive(event.description, 5_000) : undefined,
    person: {
      ...event.person,
      headline: event.person.headline
        ? redactSensitive(event.person.headline, 500)
        : undefined,
      biography: event.person.biography
        ? redactSensitive(event.person.biography, 2_000)
        : undefined,
    },
  };
}

function workPageUrls(html: string, pageUrl: string, limit: number) {
  const $ = cheerio.load(html);
  const urls = new Set<string>();
  $("a[href]").each((_, element) => {
    const target = safeHttpUrl($(element).attr("href"), pageUrl);
    if (!target || !isSameOrigin(target.toString(), pageUrl)) return;
    if (!/\/(blog|posts?|writing|projects?|research|notes?|articles?|publications?)\b/i.test(target.pathname)) return;
    if (/\/(login|log-in|signin|sign-in|account|admin|contact|privacy|terms)(?:\/|$)/i.test(target.pathname)) return;
    target.hash = "";
    urls.add(target.toString());
  });
  return [...urls].slice(0, limit);
}

function rebindKnownCandidate(
  event: DiscoveryEvent,
  person: PersonObservation,
  websiteUrl: string,
  contactRoutes: CandidateContactRoute[] = [],
): DiscoveryEvent | null {
  const observedAuthor = normalizedName(event.person.displayName);
  const knownName = normalizedName(person.displayName);
  if (!observedAuthor || !knownName || observedAuthor !== knownName) return null;
  if (!isSameOrigin(event.sourceUrl, websiteUrl)) return null;
  const evidence = event.evidence.filter((item) => isSameOrigin(item.url, websiteUrl));
  return redactEvent({
    ...event,
    evidence: evidence.length
      ? evidence
      : [{ label: "web-presence", url: event.sourceUrl, publishedAt: event.occurredAt }],
    person: {
      ...person,
      websiteUrl,
      contactRoutes: normalizeContactRoutes(
        [...(person.contactRoutes ?? []), ...contactRoutes],
        person.explicitCareerStage,
      ),
    },
    raw: {
      ...(event.raw ?? {}),
      candidateWebsite: websiteUrl,
      attribution: "exact-author-and-known-domain",
    },
  });
}

export class WebPresenceConnector implements DiscoveryConnector {
  readonly kind = "web-presence" as const;
  readonly displayName = "Personal sites, sitemaps, and JSON-LD";

  async discover(context: ConnectorRunContext): Promise<ConnectorRunResult> {
    const configured = context.settings.urls?.filter(Boolean) ?? [];
    const maxItems = Math.min(200, context.settings.maxItems ?? 60);
    const events: DiscoveryEvent[] = [];
    const warnings: string[] = [];
    const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });

    for (const configuredUrl of configured.slice(0, 30)) {
      try {
        const response = await smartFetch(configuredUrl, {
          respectRobots: true,
          signal: context.signal,
          rateLimitPerSecond: 0.3,
          maxBytes: 5_000_000,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.text();
        const contentType = response.headers.get("content-type") ?? "";
        if (contentType.includes("xml") || /^\s*<\?xml/i.test(body)) {
          const parsed = parser.parse(body) as {
            rss?: unknown;
            feed?: unknown;
            urlset?: { url?: Array<{ loc?: string; lastmod?: string }> | { loc?: string; lastmod?: string } };
          };
          if (parsed.rss || parsed.feed) {
            const feed = new FeedConnector("web-presence", this.displayName);
            const result = await feed.discover({
              ...context,
              settings: { ...context.settings, urls: [configuredUrl], maxItems },
            });
            events.push(...result.events);
            warnings.push(...(result.warnings ?? []));
            continue;
          }
          const rootUrl = safeHttpUrl(configuredUrl);
          if (!rootUrl) throw new Error("Invalid public website URL");
          const pages = list(parsed.urlset?.url)
            .flatMap((entry) => {
              const loc = safeHttpUrl(String(entry.loc ?? ""), configuredUrl);
              return loc ? [{ loc: loc.toString(), lastmod: String(entry.lastmod ?? "") }] : [];
            })
            .filter(
              (entry) =>
                isSameOrigin(entry.loc, rootUrl.toString()) &&
                /\/(blog|posts?|writing|projects?|research|notes?|articles?)\b/i.test(
                  new URL(entry.loc).pathname,
                ),
            )
            .sort((left, right) => right.lastmod.localeCompare(left.lastmod))
            .slice(0, Math.min(20, maxItems));
          const pageEvents = await mapLimit(pages, 3, async ({ loc }) => {
            try {
              const page = await smartFetch(loc, {
                respectRobots: true,
                signal: context.signal,
                rateLimitPerSecond: 0.3,
                maxBytes: 3_000_000,
              });
              if (!page.ok) return [];
              const html = await page.text();
              if (ACCESS_GATE.test(html.slice(0, 100_000))) return [];
              return eventsFromHtml(html, loc, context.now);
            } catch {
              return [];
            }
          });
          events.push(...pageEvents.flat());
          continue;
        }

        if (ACCESS_GATE.test(body.slice(0, 100_000))) {
          warnings.push(`${configuredUrl}: page appears access-controlled`);
          continue;
        }
        events.push(...eventsFromHtml(body, configuredUrl, context.now));
        const $ = cheerio.load(body);
        const feedUrls = $('link[rel="alternate"]')
          .map((_, element) => {
            const type = $(element).attr("type") ?? "";
            const href = $(element).attr("href");
            if (!href || !/(rss|atom|xml)/i.test(type)) return null;
            const target = safeHttpUrl(href, configuredUrl);
            return target && isSameOrigin(target.toString(), configuredUrl)
              ? target.toString()
              : null;
          })
          .get()
          .slice(0, 5);
        if (feedUrls.length) {
          const feed = new FeedConnector("web-presence", this.displayName);
          const result = await feed.discover({
            ...context,
            settings: { ...context.settings, urls: feedUrls, maxItems },
          });
          events.push(...result.events);
          warnings.push(...(result.warnings ?? []));
        }
        const linkedPages = workPageUrls(
          body,
          configuredUrl,
          Math.min(12, Math.max(0, maxItems - events.length)),
        );
        const linkedEvents = await mapLimit(linkedPages, 2, async (pageUrl) => {
          try {
            const page = await smartFetch(pageUrl, {
              respectRobots: true,
              signal: context.signal,
              rateLimitPerSecond: 0.3,
              maxBytes: 3_000_000,
            });
            if (!page.ok || !(page.headers.get("content-type") ?? "").includes("html")) return [];
            const html = await page.text();
            if (ACCESS_GATE.test(html.slice(0, 100_000))) return [];
            return eventsFromHtml(html, pageUrl, context.now);
          } catch {
            return [];
          }
        });
        events.push(...linkedEvents.flat());
      } catch (error) {
        warnings.push(
          `${configuredUrl}: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }
    }
    return {
      events: events.slice(0, maxItems).map(redactEvent),
      cursor: { since: context.now.toISOString() },
      warnings,
    };
  }

  async enrich(context: ConnectorEnrichmentContext): Promise<ConnectorRunResult | null> {
    if (!context.person.websiteUrl) return null;
    const candidateWebsite = safeHttpUrl(context.person.websiteUrl);
    if (!candidateWebsite) {
      return { events: [], warnings: ["Candidate website is not a valid HTTP(S) URL."] };
    }
    try {
      await assertPublicHttpUrl(candidateWebsite.toString());
    } catch {
      return { events: [], warnings: ["Candidate website is not publicly reachable."] };
    }
    const result = await this.discover({
      now: context.now,
      settings: {
        ...context.settings,
        enabled: true,
        urls: [candidateWebsite.toString()],
        maxItems: Math.min(60, context.settings.maxItems ?? 30),
      },
      signal: context.signal,
    });
    let contactRoutes: CandidateContactRoute[] = [];
    let linkedIdentities: ExternalIdentity[] = [];
    let ownedPageEvidence: ReturnType<typeof ownedWorkProfileFromHtml> = null;
    try {
      const profile = await smartFetch(candidateWebsite.toString(), {
        respectRobots: true,
        signal: context.signal,
        rateLimitPerSecond: 0.3,
        maxBytes: 2_000_000,
      });
      if (
        profile.ok &&
        (profile.headers.get("content-type") ?? "").includes("html")
      ) {
        const html = await profile.text();
        if (!ACCESS_GATE.test(html.slice(0, 100_000))) {
          ownedPageEvidence = ownedWorkProfileFromHtml(html);
          contactRoutes = publicContactRoutesFromHtml(
            html,
            candidateWebsite.toString(),
            context.person.explicitCareerStage,
          );
          linkedIdentities = await discoverCrossProfileIdentitiesFromHtml({
            html,
            pageUrl: candidateWebsite.toString(),
            expectedIdentities: context.person.identities,
            sourceOwned: true,
            signal: context.signal,
          });
        }
      }
    } catch {
      // Contact discovery is optional; work evidence remains usable when it fails.
    }
    const identityKeys = new Set<string>();
    const person: PersonObservation = {
      ...context.person,
      headline:
        context.person.headline ||
        ownedPageEvidence?.profileHeadline ||
        ownedPageEvidence?.description.slice(0, 500),
      biography: context.person.biography || ownedPageEvidence?.description,
      affiliations: [
        ...(context.person.affiliations ?? []),
        ...(ownedPageEvidence?.affiliations ?? []),
      ].filter((value, index, values) => values.indexOf(value) === index).slice(0, 12),
      websiteUrl: candidateWebsite.toString(),
      identities: [...context.person.identities, ...linkedIdentities]
        .filter((identity) => {
          const key = `${identity.provider}:${identity.externalId}`.toLowerCase();
          if (identityKeys.has(key)) return false;
          identityKeys.add(key);
          return true;
        })
        .slice(0, 10),
      contactRoutes: normalizeContactRoutes(
        [...(context.person.contactRoutes ?? []), ...contactRoutes],
        context.person.explicitCareerStage,
      ),
    };
    const reboundEvents = result.events.flatMap((event) => {
      const rebound = rebindKnownCandidate(
        event,
        person,
        candidateWebsite.toString(),
        contactRoutes,
      );
      return rebound ? [rebound] : [];
    });
    if (linkedIdentities.length && !reboundEvents.some((event) => event.type === "profile_observed")) {
      reboundEvents.unshift(createDiscoveryEvent({
        source: "web-presence",
        sourceExternalId: `linked-profiles:${stableHash(candidateWebsite.toString(), ...linkedIdentities.map((identity) => `${identity.provider}:${identity.externalId}`))}`,
        type: "profile_observed",
        title: `Public profiles listed on ${candidateWebsite.hostname}`,
        description: "Candidate-owned profile links published on the verified personal site.",
        occurredAt: context.now.toISOString(),
        sourceUrl: candidateWebsite.toString(),
        person,
        tags: ["personal-site", "cross-profile"],
        confidence: 0.94,
        now: context.now,
      }));
    }
    if (ownedPageEvidence && linkedIdentities.some((identity) => identity.verified === true)) {
      reboundEvents.unshift(createDiscoveryEvent({
        source: "web-presence",
        sourceExternalId: `owned-work-page:${ownedPageEvidence.contentHash}`,
        type: "other",
        title: `${person.displayName}'s public work profile`,
        description: ownedPageEvidence.description,
        occurredAt: context.now.toISOString(),
        sourceUrl: candidateWebsite.toString(),
        person,
        tags: ["personal-site", "candidate-owned-work-page"],
        confidence: 0.9,
        now: context.now,
      }));
    }
    return {
      ...result,
      events: reboundEvents,
    };
  }
}
