import * as cheerio from "cheerio";

import { fetchJson, smartFetch } from "./http";
import { assertPublicHttpUrl, sanitizePlainText } from "./security";
import type { ExternalIdentity } from "./types";

type ProfileProvider = "github" | "gitlab" | "hacker-news" | "x" | "linkedin-manual" | "website";

export type CrossProfileClaim = {
  provider: ProfileProvider;
  handle?: string;
  profileUrl: string;
  proof: "rel-me" | "jsonld-same-as" | "profile-link";
};

type GitHubPublicUser = {
  id?: number;
  login?: string;
  html_url?: string;
  type?: string;
};

type GitLabPublicUser = {
  id?: number;
  username?: string;
  web_url?: string;
  state?: string;
};

type HackerNewsPublicUser = {
  id?: string;
};

const RESERVED = {
  github: new Set([
    "about", "apps", "collections", "customer-stories", "enterprise", "events", "explore",
    "features", "issues", "login", "marketplace", "new", "notifications", "organizations",
    "orgs", "pricing", "pulls", "search", "security", "settings", "site", "sponsors",
    "topics", "trending",
  ]),
  gitlab: new Set(["dashboard", "explore", "groups", "help", "projects", "search", "users"]),
  x: new Set(["compose", "explore", "hashtag", "home", "i", "intent", "messages", "search", "share"]),
} as const;

function safeProfileUrl(value: unknown, baseUrl: string): URL | null {
  try {
    const url = new URL(String(value ?? ""), baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.hostname = url.hostname.replace(/^www\./i, "").replace(/\.$/, "").toLowerCase();
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

function directHandle(url: URL, hostname: string, reserved: ReadonlySet<string>) {
  if (url.hostname !== hostname) return null;
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 1) return null;
  const handle = decodeURIComponent(segments[0]);
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/.test(handle)) return null;
  if (reserved.has(handle.toLowerCase())) return null;
  return handle;
}

function claimForUrl(rawUrl: unknown, baseUrl: string, proof: CrossProfileClaim["proof"]): CrossProfileClaim | null {
  const url = safeProfileUrl(rawUrl, baseUrl);
  if (!url) return null;
  const github = directHandle(url, "github.com", RESERVED.github);
  if (github) {
    return { provider: "github", handle: github, profileUrl: `https://github.com/${github}`, proof };
  }
  const gitlab = directHandle(url, "gitlab.com", RESERVED.gitlab);
  if (gitlab) {
    return { provider: "gitlab", handle: gitlab, profileUrl: `https://gitlab.com/${gitlab}`, proof };
  }
  if (url.hostname === "news.ycombinator.com" && url.pathname === "/user") {
    const handle = sanitizePlainText(url.searchParams.get("id"), 80);
    if (/^[A-Za-z0-9_-]{2,80}$/.test(handle)) {
      return {
        provider: "hacker-news",
        handle,
        profileUrl: `https://news.ycombinator.com/user?id=${encodeURIComponent(handle)}`,
        proof,
      };
    }
  }
  if (url.hostname === "x.com" || url.hostname === "twitter.com") {
    const handle = directHandle(url, url.hostname, RESERVED.x);
    if (handle && /^[A-Za-z0-9_]{1,15}$/.test(handle)) {
      return { provider: "x", handle, profileUrl: `https://x.com/${handle}`, proof };
    }
  }
  if (url.hostname === "linkedin.com") {
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length === 2 && segments[0].toLowerCase() === "in" && /^[A-Za-z0-9_-]{2,150}$/.test(segments[1])) {
      return {
        provider: "linkedin-manual",
        handle: segments[1],
        profileUrl: `https://www.linkedin.com/in/${segments[1]}`,
        proof,
      };
    }
  }
  if (proof !== "profile-link") {
    url.search = "";
    const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
    return { provider: "website", profileUrl: `${url.origin}${path}`, proof };
  }
  return null;
}

/** Parse a direct public account URL without treating the search result as proof of identity. */
export function crossProfileClaimForUrl(value: string): CrossProfileClaim | null {
  return claimForUrl(value, value, "profile-link");
}

function jsonLdSameAs(html: string): string[] {
  const $ = cheerio.load(html);
  const urls: string[] = [];
  $('script[type="application/ld+json"]').each((_, element) => {
    try {
      const parsed = JSON.parse($(element).text().slice(0, 200_000)) as unknown;
      const visit = (value: unknown) => {
        if (Array.isArray(value)) return value.forEach(visit);
        if (!value || typeof value !== "object") return;
        const record = value as Record<string, unknown>;
        const types = Array.isArray(record["@type"]) ? record["@type"] : [record["@type"]];
        if (types.some((type) => String(type).toLowerCase() === "person")) {
          const sameAs = Array.isArray(record.sameAs) ? record.sameAs : [record.sameAs];
          for (const item of sameAs) if (typeof item === "string") urls.push(item);
        }
        if (record["@graph"]) visit(record["@graph"]);
      };
      visit(parsed);
    } catch {
      // Page-authored JSON-LD is optional and never evaluated as code.
    }
  });
  return urls;
}

export function extractCrossProfileClaims(html: string, pageUrl: string): CrossProfileClaim[] {
  const $ = cheerio.load(html);
  const claims: CrossProfileClaim[] = [];
  $("a[href], link[href]").each((_, element) => {
    const rel = String($(element).attr("rel") ?? "").toLowerCase().split(/\s+/);
    const proof = rel.includes("me") ? "rel-me" : "profile-link";
    const claim = claimForUrl($(element).attr("href"), pageUrl, proof);
    if (claim) claims.push(claim);
  });
  for (const sameAs of jsonLdSameAs(html)) {
    const claim = claimForUrl(sameAs, pageUrl, "jsonld-same-as");
    if (claim) claims.push(claim);
  }
  const proofStrength = { "profile-link": 0, "rel-me": 1, "jsonld-same-as": 2 } as const;
  const strongest = new Map<string, CrossProfileClaim>();
  for (const claim of claims) {
    const key = `${claim.provider}:${claim.profileUrl}`.toLowerCase();
    const existing = strongest.get(key);
    if (!existing || proofStrength[claim.proof] > proofStrength[existing.proof]) {
      strongest.set(key, claim);
    }
  }
  return [...strongest.values()].slice(0, 12);
}

function githubHeaders(): HeadersInit {
  return {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
  };
}

async function resolveProviderSubject(claim: CrossProfileClaim, signal?: AbortSignal): Promise<ExternalIdentity | null> {
  if (claim.provider === "github" && claim.handle) {
    const user = await fetchJson<GitHubPublicUser>(`https://api.github.com/users/${encodeURIComponent(claim.handle)}`, {
      headers: githubHeaders(),
      rateLimitPerSecond: process.env.GITHUB_TOKEN ? 4 : 0.5,
      signal,
    }).catch(() => null);
    if (!user?.id || !user.login || user.type !== "User" || user.login.toLowerCase() !== claim.handle.toLowerCase()) return null;
    return { provider: "github", externalId: String(user.id), username: user.login, profileUrl: user.html_url || claim.profileUrl };
  }
  if (claim.provider === "gitlab" && claim.handle) {
    const users = await fetchJson<GitLabPublicUser[]>(`https://gitlab.com/api/v4/users?username=${encodeURIComponent(claim.handle)}`, {
      rateLimitPerSecond: 1,
      signal,
    }).catch(() => []);
    const user = users.find((item) => item.username?.toLowerCase() === claim.handle!.toLowerCase() && item.state !== "blocked");
    if (!user?.id || !user.username) return null;
    return { provider: "gitlab", externalId: String(user.id), username: user.username, profileUrl: user.web_url || claim.profileUrl };
  }
  if (claim.provider === "hacker-news" && claim.handle) {
    const user = await fetchJson<HackerNewsPublicUser>(`https://hacker-news.firebaseio.com/v0/user/${encodeURIComponent(claim.handle)}.json`, {
      rateLimitPerSecond: 8,
      signal,
    }).catch(() => null);
    if (!user?.id || user.id.toLowerCase() !== claim.handle.toLowerCase()) return null;
    return { provider: "hacker-news", externalId: user.id, username: user.id, profileUrl: claim.profileUrl };
  }
  return {
    provider: claim.provider,
    externalId: claim.provider === "website" ? claim.profileUrl : claim.handle || claim.profileUrl,
    username: claim.handle,
    profileUrl: claim.profileUrl,
  };
}

function matchesExpectedHandle(identity: ExternalIdentity, expected: ExternalIdentity[]) {
  return expected.some((item) =>
    Boolean(item.username && identity.username) &&
    item.username!.toLowerCase() === identity.username!.toLowerCase(),
  );
}

export async function resolveCrossProfileClaims(input: {
  claims: CrossProfileClaim[];
  expectedIdentities?: ExternalIdentity[];
  sourceOwned?: boolean;
  sourceUrl?: string;
  signal?: AbortSignal;
}): Promise<ExternalIdentity[]> {
  const resolved = await Promise.all(input.claims.slice(0, 12).map(async (claim) => {
    const identity = await resolveProviderSubject(claim, input.signal);
    if (!identity) return null;
    const explicitSelfClaim = claim.proof === "rel-me" || claim.proof === "jsonld-same-as";
    const verified = Boolean(
      (input.sourceOwned && matchesExpectedHandle(identity, input.expectedIdentities ?? [])) ||
      (input.sourceOwned && explicitSelfClaim),
    );
    return {
      ...identity,
      verified,
      confidence: verified ? 0.96 : explicitSelfClaim ? 0.78 : 0.62,
      proof: claim.proof,
      proofSourceUrl: input.sourceUrl || identity.profileUrl,
    } satisfies ExternalIdentity;
  }));
  const seen = new Set<string>();
  return resolved.flatMap((identity): ExternalIdentity[] => {
    if (!identity) return [];
    const key = `${identity.provider}:${identity.externalId}`.toLowerCase();
    if (seen.has(key)) return [];
    seen.add(key);
    return [identity];
  });
}

export async function discoverCrossProfileIdentitiesFromHtml(input: {
  html: string;
  pageUrl: string;
  expectedIdentities?: ExternalIdentity[];
  sourceOwned?: boolean;
  signal?: AbortSignal;
}) {
  return resolveCrossProfileClaims({
    claims: extractCrossProfileClaims(input.html, input.pageUrl),
    expectedIdentities: input.expectedIdentities,
    sourceOwned: input.sourceOwned,
    sourceUrl: input.pageUrl,
    signal: input.signal,
  });
}

export async function discoverCrossProfileIdentitiesFromUrl(input: {
  pageUrl: string;
  expectedIdentities?: ExternalIdentity[];
  sourceOwned?: boolean;
  signal?: AbortSignal;
}): Promise<ExternalIdentity[]> {
  const publicUrl = await assertPublicHttpUrl(input.pageUrl);
  const response = await smartFetch(publicUrl.toString(), {
    respectRobots: true,
    signal: input.signal,
    rateLimitPerSecond: 0.3,
    maxBytes: 2_000_000,
  });
  if (!response.ok || !(response.headers.get("content-type") ?? "").includes("html")) return [];
  return discoverCrossProfileIdentitiesFromHtml({ ...input, pageUrl: publicUrl.toString(), html: await response.text() });
}

/** Legacy helper kept for callers and tests that only need one direct GitHub link. */
export function extractSingleGitHubProfileHandle(html: string): string | null {
  const handles = extractCrossProfileClaims(html, "https://example.invalid")
    .filter((claim) => claim.provider === "github")
    .map((claim) => claim.handle!)
    .filter(Boolean);
  const unique = new Map(handles.map((handle) => [handle.toLowerCase(), handle]));
  return unique.size === 1 ? [...unique.values()][0] : null;
}

export async function resolveGitHubIdentityFromProfileHtml(
  html: string,
  signal?: AbortSignal,
  expectedUsername?: string,
): Promise<ExternalIdentity | null> {
  const identities = await discoverCrossProfileIdentitiesFromHtml({
    html,
    pageUrl: "https://news.ycombinator.com/",
    expectedIdentities: expectedUsername ? [{ provider: "hacker-news", externalId: expectedUsername, username: expectedUsername }] : [],
    signal,
  });
  const github = identities.find((identity) => identity.provider === "github");
  if (!github) return null;
  return {
    ...github,
    verified: Boolean(expectedUsername && github.username?.toLowerCase() === expectedUsername.toLowerCase()),
  };
}
