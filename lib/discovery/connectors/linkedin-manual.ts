import { stableHash } from "../idempotency";
import {
  assertLinkedInDirectAccessApproved,
  isLinkedInDirectAccessApproved,
  normalizeLinkedInMemberUrl,
} from "../linkedin-policy";
import { sanitizePlainText } from "../security";
import { fetchJson } from "../http";
import type {
  ConnectorEnrichmentContext,
  ConnectorRunContext,
  ConnectorRunResult,
  DiscoveryConnector,
  PersonObservation,
} from "../types";
import { asStringArray, createDiscoveryEvent } from "./shared";

type ManualProfile = {
  name: string;
  profileUrl: string;
  headline?: string;
  biography?: string;
  location?: string;
  affiliations?: string[];
  websiteUrl?: string;
  observedAt?: string;
  note?: string;
  provenanceUrl?: string;
  reviewed: boolean;
};

type ApprovedProfile = {
  memberId?: unknown;
  profileUrl?: unknown;
  name?: unknown;
  headline?: unknown;
  biography?: unknown;
  location?: unknown;
  affiliations?: unknown;
  websiteUrl?: unknown;
  alternateNames?: unknown;
};

export function parseApprovedLinkedInProfile(value: ApprovedProfile, expectedUrl: string) {
  const memberId = sanitizePlainText(value.memberId, 500);
  const profileUrl = normalizeLinkedInMemberUrl(value.profileUrl);
  const name = sanitizePlainText(value.name, 200);
  if (!memberId || !profileUrl || profileUrl !== expectedUrl || !name) return null;
  const websiteUrl = sanitizePlainText(value.websiteUrl, 2_000);
  return {
    memberId,
    profileUrl,
    name,
    headline: sanitizePlainText(value.headline, 500) || undefined,
    biography: sanitizePlainText(value.biography, 2_000) || undefined,
    location: sanitizePlainText(value.location, 300) || undefined,
    affiliations: asStringArray(value.affiliations, 20),
    websiteUrl: /^https:\/\//i.test(websiteUrl) ? websiteUrl : undefined,
    alternateNames: asStringArray(value.alternateNames, 12),
  };
}

function profiles(value: unknown): ManualProfile[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .map((item) => ({
      name: sanitizePlainText(item.name, 200),
      profileUrl: sanitizePlainText(item.profileUrl, 2_000),
      headline: sanitizePlainText(item.headline, 500) || undefined,
      biography: sanitizePlainText(item.biography, 2_000) || undefined,
      location: sanitizePlainText(item.location, 300) || undefined,
      affiliations: asStringArray(item.affiliations, 20),
      websiteUrl: sanitizePlainText(item.websiteUrl, 2_000) || undefined,
      observedAt: sanitizePlainText(item.observedAt, 100) || undefined,
      note: sanitizePlainText(item.note, 2_000) || undefined,
      provenanceUrl: sanitizePlainText(item.provenanceUrl, 2_000) || undefined,
      reviewed: item.reviewed === true,
    }))
    .flatMap((item) => {
      const profileUrl = normalizeLinkedInMemberUrl(item.profileUrl);
      return item.name && item.reviewed && profileUrl ? [{ ...item, profileUrl }] : [];
    })
    .slice(0, 500);
}

/**
 * LinkedIn profile pages are never fetched. Manual records are accepted directly;
 * separately approved customers can point the connector at a server-side profile
 * lookup endpoint whose data contract is documented in docs/connectors.md.
 */
export class LinkedInManualConnector implements DiscoveryConnector {
  readonly kind = "linkedin-manual" as const;
  readonly displayName = "LinkedIn manual or approved integration";

  async discover(context: ConnectorRunContext): Promise<ConnectorRunResult> {
    const events = profiles(context.settings.options?.profiles).map((profile) => {
      const person: PersonObservation = {
        displayName: profile.name,
        identities: [
          {
            provider: "linkedin-manual",
            externalId: stableHash(profile.profileUrl),
            profileUrl: profile.profileUrl,
            verified: true,
          },
        ],
        headline: profile.headline,
        biography: profile.biography,
        location: profile.location,
        affiliations: profile.affiliations,
        websiteUrl: profile.websiteUrl,
        sourceUrl: profile.provenanceUrl || profile.profileUrl,
      };
      return createDiscoveryEvent({
        source: "linkedin-manual",
        sourceExternalId: stableHash(profile.profileUrl, profile.observedAt),
        type: "profile_observed",
        title: `${profile.name}'s profile was added for review`,
        description: profile.note || profile.headline,
        occurredAt: profile.observedAt,
        sourceUrl: profile.provenanceUrl || profile.profileUrl,
        person,
        tags: ["manual-review", "operator-confirmed-url"],
        confidence: 0.9,
        now: context.now,
      });
    });

    return {
      events,
      warnings: [
        "LinkedIn ingestion is manual/approved-integration only; unauthorized scraping is disabled by design.",
      ],
    };
  }

  async enrich(context: ConnectorEnrichmentContext): Promise<ConnectorRunResult | null> {
    if (!isLinkedInDirectAccessApproved()) return null;
    assertLinkedInDirectAccessApproved();
    const expectedUrl = context.person.identities
      .filter((identity) => identity.provider === "linkedin-manual")
      .map((identity) => normalizeLinkedInMemberUrl(identity.profileUrl))
      .find((value): value is string => Boolean(value));
    if (!expectedUrl) return null;

    const endpoint = new URL(process.env.LINKEDIN_APPROVED_API_BASE_URL!);
    endpoint.searchParams.set("profileUrl", expectedUrl);
    const response = await fetchJson<ApprovedProfile>(endpoint.toString(), {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${process.env.LINKEDIN_APPROVED_API_TOKEN}`,
      },
      maxBytes: 500_000,
      rateLimitPerSecond: 1,
      signal: context.signal,
    });
    const profile = parseApprovedLinkedInProfile(response, expectedUrl);
    if (!profile) {
      return {
        events: [],
        warnings: ["The approved LinkedIn response did not match the requested public profile URL."],
      };
    }
    const aliases = [
      ...profile.alternateNames,
      ...(profile.name.toLocaleLowerCase("en-US") !== context.person.displayName.toLocaleLowerCase("en-US")
        ? [profile.name]
        : []),
    ];
    const person: PersonObservation = {
      ...context.person,
      displayName: context.person.displayName,
      identities: [
        ...context.person.identities.filter((identity) => identity.provider !== "linkedin-manual"),
        {
          provider: "linkedin-manual",
          externalId: profile.memberId,
          profileUrl: profile.profileUrl,
          username: new URL(profile.profileUrl).pathname.split("/").filter(Boolean).at(-1),
          verified: true,
          confidence: 0.98,
          proof: "provider-api",
          proofSourceUrl: profile.profileUrl,
        },
      ],
      headline: profile.headline || context.person.headline,
      biography: profile.biography || context.person.biography,
      location: profile.location || context.person.location,
      affiliations: [...new Set([...(context.person.affiliations ?? []), ...profile.affiliations])].slice(0, 20),
      websiteUrl: profile.websiteUrl || context.person.websiteUrl,
      alternateNames: [
        ...(context.person.alternateNames ?? []),
        ...aliases.map((name) => ({
          name,
          sourceUrl: profile.profileUrl,
          confidence: 0.98,
          proof: "provider-profile" as const,
        })),
      ],
      sourceUrl: profile.profileUrl,
    };
    return {
      events: [createDiscoveryEvent({
        source: "linkedin-manual",
        sourceExternalId: stableHash(profile.memberId, profile.profileUrl),
        type: "profile_observed",
        title: `${context.person.displayName}'s LinkedIn profile was verified`,
        description: profile.headline,
        sourceUrl: profile.profileUrl,
        person,
        tags: ["approved-api", "verified-provider-subject"],
        confidence: 0.98,
        now: context.now,
      })],
    };
  }
}
