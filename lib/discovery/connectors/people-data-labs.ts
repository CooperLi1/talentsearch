import { stableHash } from "../idempotency";
import { normalizeLinkedInMemberUrl } from "../linkedin-policy";
import { smartFetch } from "../http";
import { sanitizePlainText } from "../security";
import type {
  ConnectorEnrichmentContext,
  ConnectorRunResult,
  DiscoveryConnector,
  PersonObservation,
} from "../types";
import { asNumber, asStringArray, clamp, createDiscoveryEvent } from "./shared";

const ENRICH_ENDPOINT = "https://api.peopledatalabs.com/v5/person/enrich";
const DEFAULT_MIN_LIKELIHOOD = 8;
const DEFAULT_REFRESH_DAYS = 90;

type PdlNamedEntity = { name?: unknown };
type PdlExperience = {
  company?: PdlNamedEntity;
  title?: PdlNamedEntity;
  start_date?: unknown;
  end_date?: unknown;
};
type PdlEducation = {
  school?: PdlNamedEntity;
  degrees?: unknown;
  start_date?: unknown;
  end_date?: unknown;
};
// Only professional-history fields are read. Contact fields the provider may
// return (emails, phone numbers, street addresses, birth data) are never
// parsed or stored.
type PdlPerson = {
  full_name?: unknown;
  job_title?: unknown;
  job_company_name?: unknown;
  location_name?: unknown;
  linkedin_url?: unknown;
  summary?: unknown;
  experience?: unknown;
  education?: unknown;
  skills?: unknown;
};
type PdlResponse = { likelihood?: unknown; data?: PdlPerson };

function yearOf(value: unknown) {
  const match = sanitizePlainText(value, 20).match(/^(\d{4})/);
  return match ? match[1] : "";
}

function spanOf(start: unknown, end: unknown) {
  const from = yearOf(start);
  const to = yearOf(end);
  if (!from && !to) return "";
  return `${from || "?"}–${to || "present"}`;
}

function namedEntity(value: unknown) {
  const entity = value && typeof value === "object" ? (value as PdlNamedEntity) : {};
  return sanitizePlainText(entity.name, 200);
}

export function parseLicensedProfile(data: PdlPerson) {
  const fullName = sanitizePlainText(data.full_name, 200);
  if (!fullName) return null;
  const jobTitle = sanitizePlainText(data.job_title, 300);
  const company = sanitizePlainText(data.job_company_name, 300);
  const experienceLines = (Array.isArray(data.experience) ? data.experience : [])
    .filter((item): item is PdlExperience => Boolean(item && typeof item === "object"))
    .map((item) => {
      const title = namedEntity(item.title);
      const employer = namedEntity(item.company);
      if (!title && !employer) return "";
      const span = spanOf(item.start_date, item.end_date);
      return [`${title || "Worked"}${employer ? ` at ${employer}` : ""}`, span ? `(${span})` : ""]
        .filter(Boolean)
        .join(" ");
    })
    .filter(Boolean)
    .slice(0, 8);
  const educationLines = (Array.isArray(data.education) ? data.education : [])
    .filter((item): item is PdlEducation => Boolean(item && typeof item === "object"))
    .map((item) => {
      const school = namedEntity(item.school);
      if (!school) return "";
      const degrees = asStringArray(item.degrees, 3).join(", ");
      const span = spanOf(item.start_date, item.end_date);
      return [`${degrees || "Studied"} at ${school}`, span ? `(${span})` : ""].filter(Boolean).join(" ");
    })
    .filter(Boolean)
    .slice(0, 4);
  const employers = (Array.isArray(data.experience) ? data.experience : [])
    .map((item) => namedEntity((item as PdlExperience)?.company))
    .filter(Boolean);
  const schools = (Array.isArray(data.education) ? data.education : [])
    .map((item) => namedEntity((item as PdlEducation)?.school))
    .filter(Boolean);
  return {
    fullName,
    headline: jobTitle ? `${jobTitle}${company ? ` at ${company}` : ""}` : undefined,
    location: sanitizePlainText(data.location_name, 300) || undefined,
    linkedInUrl: normalizeLinkedInMemberUrl(data.linkedin_url),
    summary: sanitizePlainText(data.summary, 2_000) || undefined,
    experienceLines,
    educationLines,
    affiliations: [...new Set([...(company ? [company] : []), ...employers, ...schools])].slice(0, 12),
    skills: asStringArray(data.skills, 10),
  };
}

export function namesRoughlyMatch(left: string, right: string) {
  const tokens = (value: string) =>
    value
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 2);
  const leftTokens = tokens(left);
  const rightTokens = new Set(tokens(right));
  if (!leftTokens.length || !rightTokens.size) return false;
  const shared = leftTokens.filter((token) => rightTokens.has(token)).length;
  return shared >= Math.min(2, leftTokens.length);
}

function describeLicensedProfile(profile: NonNullable<ReturnType<typeof parseLicensedProfile>>) {
  const sections = [
    profile.experienceLines.length ? `Work history: ${profile.experienceLines.join("; ")}` : "",
    profile.educationLines.length ? `Education: ${profile.educationLines.join("; ")}` : "",
    profile.skills.length ? `Listed skills: ${profile.skills.join(", ")}` : "",
    profile.summary ? `Self-description: ${profile.summary}` : "",
  ];
  return sections.filter(Boolean).join("\n");
}

/**
 * Licensed professional-history enrichment. Nothing is ever fetched from
 * linkedin.com: the provider licenses aggregated public-profile data and this
 * connector reads only work history, education, skills, and location from it.
 */
export class PeopleDataLabsConnector implements DiscoveryConnector {
  readonly kind = "people-data-labs" as const;
  readonly displayName = "People Data Labs licensed profiles";

  async discover(): Promise<ConnectorRunResult> {
    return { events: [], warnings: ["Licensed profile enrichment runs only after a candidate exists."] };
  }

  async enrich(context: ConnectorEnrichmentContext): Promise<ConnectorRunResult | null> {
    const apiKey = process.env.PEOPLE_DATA_SEARCH_KEY?.trim();
    if (!apiKey) return null;

    // Every successful match is billed, so one lookup per person per refresh
    // window: skip anyone with a licensed-profile event inside the window.
    const refreshDays = Math.max(1, Math.floor(asNumber(context.settings.lookbackDays, DEFAULT_REFRESH_DAYS)));
    const cutoff = context.now.getTime() - refreshDays * 86_400_000;
    const alreadyLicensed = (context.evidenceEvents ?? []).some(
      (event) =>
        event.source === this.kind &&
        Date.parse(event.discoveredAt || event.occurredAt) >= cutoff,
    );
    if (alreadyLicensed) return null;

    const linkedInUrl =
      context.person.identities
        .map((identity) => normalizeLinkedInMemberUrl(identity.profileUrl))
        .find((value): value is string => Boolean(value)) ?? null;
    const name = sanitizePlainText(context.person.displayName, 200);
    const affiliation = (context.person.affiliations ?? [])
      .map((value) => sanitizePlainText(value, 200))
      .find(Boolean);
    const location = sanitizePlainText(context.person.location, 300);
    const minLikelihood = Math.min(
      10,
      Math.max(1, Math.floor(asNumber(context.settings.options?.minLikelihood, DEFAULT_MIN_LIKELIHOOD))),
    );

    const endpoint = new URL(ENRICH_ENDPOINT);
    endpoint.searchParams.set("min_likelihood", String(minLikelihood));
    if (linkedInUrl) {
      endpoint.searchParams.set("profile", linkedInUrl);
    } else {
      // A fuzzy lookup needs a plausible human name plus at least one
      // corroborating anchor, or common names would bill for wrong people.
      if (name.split(/\s+/).filter(Boolean).length < 2 || (!affiliation && !location)) return null;
      endpoint.searchParams.set("name", name);
      // Scholarly-sourced affiliations are usually institutions; the provider
      // matches those on its school field, not employer.
      if (affiliation) {
        const academic = /\b(universit|institute|college|school|academy|polytech|laborator)\b/i.test(affiliation);
        endpoint.searchParams.set(academic ? "school" : "company", affiliation);
      }
      if (location) endpoint.searchParams.set("location", location);
    }

    const response = await smartFetch(endpoint.toString(), {
      headers: { accept: "application/json", "x-api-key": apiKey },
      rateLimitPerSecond: 1,
      timeoutMs: 12_000,
      retries: 1,
      maxBytes: 2_000_000,
      signal: context.signal,
    });
    // 404 is the provider's unbilled no-match answer, not a failure.
    if (response.status === 404) return { events: [] };
    if (!response.ok) throw new Error(`People Data Labs returned HTTP ${response.status}`);
    const payload = (await response.json()) as PdlResponse;
    const likelihood = clamp(asNumber(payload.likelihood, 0), 0, 10);
    const profile = parseLicensedProfile(payload.data ?? {});
    if (!profile) {
      return { events: [], warnings: ["The licensed profile response contained no usable fields."] };
    }
    if (linkedInUrl && profile.linkedInUrl && profile.linkedInUrl !== linkedInUrl) {
      return {
        events: [],
        warnings: ["The licensed profile response did not match the requested LinkedIn member URL."],
      };
    }
    const exact = Boolean(linkedInUrl && profile.linkedInUrl === linkedInUrl);
    if (!exact && !namesRoughlyMatch(profile.fullName, name)) {
      return {
        events: [],
        warnings: [`A licensed match for ${name} was discarded because the returned name did not correspond.`],
      };
    }

    const linkedInIdentity = profile.linkedInUrl
      ? [{
          provider: "linkedin-manual" as const,
          externalId: stableHash(profile.linkedInUrl),
          profileUrl: profile.linkedInUrl,
          username: new URL(profile.linkedInUrl).pathname.split("/").filter(Boolean).at(-1),
          verified: exact,
          confidence: exact ? 0.95 : clamp(likelihood / 10, 0, 0.85),
          proof: "provider-api" as const,
          proofSourceUrl: profile.linkedInUrl,
        }]
      : [];
    const person: PersonObservation = {
      ...context.person,
      identities: [
        ...context.person.identities.filter(
          (identity) =>
            !linkedInIdentity.length ||
            identity.provider !== "linkedin-manual" ||
            identity.externalId !== linkedInIdentity[0]!.externalId ||
            identity.verified === true,
        ),
        ...linkedInIdentity.filter(
          (identity) =>
            !context.person.identities.some(
              (existing) =>
                existing.provider === identity.provider &&
                existing.externalId === identity.externalId &&
                existing.verified === true,
            ),
        ),
      ].slice(0, 16),
      headline: context.person.headline || profile.headline,
      biography: context.person.biography || profile.summary,
      location: context.person.location || profile.location,
      affiliations: [
        ...new Set([...(context.person.affiliations ?? []), ...profile.affiliations]),
      ].slice(0, 12),
    };

    return {
      events: [
        createDiscoveryEvent({
          source: this.kind,
          sourceExternalId: stableHash(profile.linkedInUrl ?? name, exact ? "profile" : "fuzzy"),
          type: "profile_observed",
          title: exact
            ? `${context.person.displayName}'s licensed work history was imported`
            : `A likely work history for ${context.person.displayName} was licensed for review`,
          description: describeLicensedProfile(profile) || profile.headline,
          sourceUrl: profile.linkedInUrl ?? context.person.sourceUrl,
          person,
          tags: [
            "licensed-data",
            exact ? "verified-provider-subject" : "requires-corroboration",
          ],
          raw: {
            provider: "people-data-labs",
            likelihood,
            matchedBy: exact ? "linkedin-profile" : "name-and-anchor",
            retrievedAt: context.now.toISOString(),
            contactFieldsStored: false,
          },
          confidence: exact ? 0.92 : clamp(0.35 + likelihood / 20, 0, 0.85),
          now: context.now,
        }),
      ],
    };
  }
}
