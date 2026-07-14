import type { CandidateContactRoute, CandidateIdentity } from "@/lib/domain/types";
import { isIP } from "node:net";

import { isBlockedIp } from "@/lib/discovery/security";

const LIKELY_MINOR_STAGE =
  /\b(high school|secondary school|middle school|grade\s*(?:[6-9]|1[0-2])|year\s*(?:[7-9]|1[0-3])|minor|olympiad|science fair|regeneron sts|isef|junior)\b/i;
const EMAIL = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i;

function safePublicHttpUrl(value: unknown) {
  try {
    const url = new URL(String(value ?? ""));
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    const hostname = url.hostname.replace(/\.$/, "").toLowerCase();
    const ipHostname = hostname.replace(/^\[|\]$/g, "");
    if (
      !hostname ||
      hostname === "localhost" ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal") ||
      (isIP(ipHostname) > 0 && isBlockedIp(ipHostname))
    ) return null;
    url.hostname = hostname;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function safeMailto(value: unknown) {
  try {
    const url = new URL(String(value ?? ""));
    if (url.protocol !== "mailto:" || url.search || url.hash) return null;
    const address = decodeURIComponent(url.pathname).trim();
    if (!EMAIL.test(address) || /^(?:no-?reply|donotreply)@/i.test(address)) return null;
    return `mailto:${address}`;
  } catch {
    return null;
  }
}

function providerUrlMatches(kind: CandidateContactRoute["kind"], value: string) {
  if (["email", "contact-page", "website"].includes(kind)) return true;
  const url = new URL(value);
  const hostname = url.hostname.replace(/^www\./, "").toLowerCase();
  if (kind === "github") return hostname === "github.com" && /^\/[A-Za-z0-9_.-]+\/?$/.test(url.pathname);
  if (kind === "gitlab") return hostname === "gitlab.com" && /^\/[A-Za-z0-9_.-]+\/?$/.test(url.pathname);
  if (kind === "hacker-news") return hostname === "news.ycombinator.com" && url.pathname === "/user" && url.searchParams.has("id");
  if (kind === "x") return ["x.com", "twitter.com"].includes(hostname) && /^\/[A-Za-z0-9_]+\/?$/.test(url.pathname);
  if (kind === "linkedin") return hostname === "linkedin.com" && /^\/in\/[^/]+\/?$/i.test(url.pathname);
  if (kind === "institutional") return isAcademicHostname(hostname);
  return false;
}

function isAcademicHostname(hostname: string) {
  return /(?:\.edu|\.ac\.[a-z]{2}|\.edu\.[a-z]{2})$/i.test(hostname);
}

export function isLikelyMinorStage(stage: string | null | undefined) {
  return LIKELY_MINOR_STAGE.test(stage ?? "");
}

function allowedRoute(input: CandidateContactRoute, likelyMinor: boolean): CandidateContactRoute | null {
  if (
    !["email", "contact-page", "github", "gitlab", "hacker-news", "x", "linkedin", "website", "institutional"].includes(input.kind) ||
    !["direct", "public-profile", "institutional"].includes(input.audience)
  ) return null;
  if (!input.verified || input.confidence < 0.85) return null;
  const provenanceUrl = safePublicHttpUrl(input.provenanceUrl);
  if (!provenanceUrl) return null;
  const url = input.kind === "email" ? safeMailto(input.url) : safePublicHttpUrl(input.url);
  if (!url) return null;
  if (!providerUrlMatches(input.kind, url)) return null;
  if (likelyMinor && input.audience === "direct") return null;
  if (likelyMinor && !["public-profile", "institutional"].includes(input.audience)) return null;
  return {
    ...input,
    label: input.label.trim().slice(0, 80),
    url,
    provenanceUrl,
    confidence: Math.min(1, Math.max(0, input.confidence)),
  };
}

export function contactRoutesFromJson(value: unknown): CandidateContactRoute[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const route = item as Record<string, unknown>;
    if (
      typeof route.kind !== "string" ||
      typeof route.label !== "string" ||
      typeof route.url !== "string" ||
      typeof route.provenanceUrl !== "string" ||
      typeof route.audience !== "string"
    ) return [];
    return [{
      kind: route.kind as CandidateContactRoute["kind"],
      label: route.label,
      url: route.url,
      provenanceUrl: route.provenanceUrl,
      confidence: Number(route.confidence),
      verified: route.verified === true,
      audience: route.audience as CandidateContactRoute["audience"],
    }];
  });
}

export function normalizeContactRoutes(
  routes: CandidateContactRoute[],
  stage?: string | null,
) {
  const likelyMinor = isLikelyMinorStage(stage);
  const byUrl = new Map<string, CandidateContactRoute>();
  for (const route of routes) {
    const normalized = allowedRoute(route, likelyMinor);
    if (!normalized) continue;
    const key = normalized.url.toLocaleLowerCase("en-US");
    const existing = byUrl.get(key);
    if (!existing || normalized.confidence > existing.confidence) byUrl.set(key, normalized);
  }
  return [...byUrl.values()].slice(0, 12);
}

function profileKind(provider: string): CandidateContactRoute["kind"] | null {
  const key = provider.toLocaleLowerCase("en-US");
  if (key === "github") return "github";
  if (key === "x") return "x";
  if (key === "linkedin-manual" || key === "linkedin") return "linkedin";
  if (key === "website" || key === "web-presence") return "website";
  if (key === "hacker-news") return "hacker-news";
  if (key === "gitlab") return "gitlab";
  return null;
}

export function contactRoutesFromIdentities(
  identities: CandidateIdentity[],
  websiteUrl?: string,
): CandidateContactRoute[] {
  const routes: CandidateContactRoute[] = [];
  for (const identity of identities) {
    const kind = profileKind(identity.provider);
    if (!kind || !identity.profileUrl || identity.resolutionStatus !== "resolved") continue;
    routes.push({
      kind,
      label: kind === "website" ? "Website" : identity.provider,
      url: identity.profileUrl,
      provenanceUrl: identity.profileUrl,
      confidence: identity.confidence,
      verified: true,
      audience: "public-profile",
    });
  }
  if (websiteUrl) {
    routes.push({
      kind: "website",
      label: "Website",
      url: websiteUrl,
      provenanceUrl: websiteUrl,
      confidence: 0.97,
      verified: true,
      audience: "public-profile",
    });
  }
  return routes;
}

export function preferredContactRoute(routes: CandidateContactRoute[]) {
  const priority: Record<CandidateContactRoute["kind"], number> = {
    email: 0,
    "contact-page": 1,
    institutional: 2,
    github: 3,
    linkedin: 4,
    x: 5,
    gitlab: 6,
    "hacker-news": 7,
    website: 8,
  };
  return [...routes].sort(
    (left, right) =>
      priority[left.kind] - priority[right.kind] || right.confidence - left.confidence,
  )[0] ?? null;
}
