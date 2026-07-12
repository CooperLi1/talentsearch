import { stableHash } from "../idempotency";
import { sanitizePlainText } from "../security";
import type {
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
};

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
    }))
    .filter((item) => item.name && /^https:\/\/(?:[a-z]+\.)?linkedin\.com\//i.test(item.profileUrl))
    .slice(0, 500);
}

/**
 * LinkedIn is intentionally manual-only. This connector accepts profiles supplied
 * by a reviewer or an approved integration; it never fetches or scrapes LinkedIn.
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
            verified: false,
          },
        ],
        headline: profile.headline,
        biography: profile.biography,
        location: profile.location,
        affiliations: profile.affiliations,
        websiteUrl: profile.websiteUrl,
        sourceUrl: profile.profileUrl,
      };
      return createDiscoveryEvent({
        source: "linkedin-manual",
        sourceExternalId: stableHash(profile.profileUrl, profile.observedAt),
        type: "profile_observed",
        title: `${profile.name}'s profile was added for review`,
        description: profile.note || profile.headline,
        occurredAt: profile.observedAt,
        sourceUrl: profile.profileUrl,
        person,
        tags: ["manual-review"],
        confidence: 0.58,
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
}
