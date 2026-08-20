import {
  identityMatchModelName,
  reviewIdentityEvidenceMatch,
  type IdentityMatchDecision,
} from "@/lib/ai/identity-match";
import { stableHash } from "../idempotency";
import { normalizeLinkedInMemberUrl } from "../linkedin-policy";
import { smartFetch } from "../http";
import { consumeProviderDailyBudget } from "../provider-budget";
import { sanitizePlainText } from "../security";
import type {
  ConnectorEnrichmentContext,
  ConnectorRunResult,
  DiscoveryConnector,
  ExternalIdentity,
  PersonObservation,
} from "../types";
import { asNumber, asStringArray, clamp, createDiscoveryEvent } from "./shared";

const ENRICH_ENDPOINT = "https://api.peopledatalabs.com/v5/person/enrich";
const PDL_EVIDENCE_URL = "https://www.peopledatalabs.com/";
const DEFAULT_MIN_LIKELIHOOD = 6;
// PDL documents that name + location lookups rarely score above 4. Official
// roster candidates still pass through exact-name and model conflict checks,
// so retrieve moderate matches for the reviewer instead of filtering them out.
const ROSTER_MIN_LIKELIHOOD = 2;
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

export function isResolvedExactLinkedInMatch(input: {
  alternateNames?: string[];
  identity?: ExternalIdentity;
  requestedName: string;
  returnedName: string;
  returnedUrl?: string | null;
}) {
  const requestedUrl = normalizeLinkedInMemberUrl(input.identity?.profileUrl);
  return input.identity?.verified === true &&
    Boolean(requestedUrl) &&
    requestedUrl === normalizeLinkedInMemberUrl(input.returnedUrl) &&
    [input.requestedName, ...(input.alternateNames ?? [])].some((name) =>
      namesRoughlyMatch(input.returnedName, name)
    );
}

export function selectLinkedInIdentityForLookup(identities: ExternalIdentity[]) {
  const withLinkedInUrl = identities.filter((identity) =>
    Boolean(normalizeLinkedInMemberUrl(identity.profileUrl))
  );
  return withLinkedInUrl.find((identity) => identity.verified === true) ??
    withLinkedInUrl[0];
}

function normalizedHumanName(value: string) {
  return value
    .toLocaleLowerCase("en-US")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function shouldBindLicensedProfileIdentity(
  exact: boolean,
  modelDecision?: IdentityMatchDecision["decision"],
  groundedRosterMatch = false,
) {
  return exact || modelDecision === "match" || groundedRosterMatch;
}

function rosterLocationFromEvidence(
  person: PersonObservation,
  evidenceEvents: ConnectorEnrichmentContext["evidenceEvents"] = [],
) {
  const expectedName = normalizedHumanName(person.displayName);
  for (const event of evidenceEvents ?? []) {
    if (!event.tags?.includes("manual-roster-deep-dive")) continue;
    const fields = (event.description ?? "").split("|").map((value) => value.trim());
    const nameIndex = fields.findIndex(
      (value) => normalizedHumanName(value) === expectedName,
    );
    const location = nameIndex >= 0 ? sanitizePlainText(fields[nameIndex + 1], 200) : "";
    if (
      location &&
      !/^https?:/i.test(location) &&
      !/^\d+(?:\.\d+)?%?$/.test(location)
    ) return location;
  }
  return "";
}

export function licensedFuzzyLookupAnchor(
  person: PersonObservation,
  evidenceEvents: ConnectorEnrichmentContext["evidenceEvents"] = [],
) {
  const affiliation = (person.affiliations ?? [])
    .map((value) => sanitizePlainText(value, 200))
    .find((value) => Boolean(value) && !/^https?:/i.test(value));
  const location = sanitizePlainText(person.location, 300);
  const rosterLocation = rosterLocationFromEvidence(person, evidenceEvents);
  if (!affiliation) {
    return location || rosterLocation ? { location: location || rosterLocation } : {};
  }
  const academic = /\b(university|universities|institute|college|school|academy|polytech|laboratory|laboratories|lab)\b/i.test(
    affiliation,
  );
  const rosterSourced = person.identities.some(
    (identity) => identity.provider === "roster-page",
  );
  if (rosterSourced && !academic) {
    return { location: location || rosterLocation || affiliation };
  }
  return {
    ...(academic ? { school: affiliation } : { company: affiliation }),
    ...(location ? { location } : {}),
  };
}

export function isGroundedRosterLicensedMatch(input: {
  person: PersonObservation;
  requestedName: string;
  returnedName: string;
  likelihood: number;
  review: IdentityMatchDecision | null;
}) {
  if (!input.person.identities.some((identity) => identity.provider === "roster-page")) {
    return false;
  }
  if (
    input.likelihood < ROSTER_MIN_LIKELIHOOD ||
    normalizedHumanName(input.requestedName) !== normalizedHumanName(input.returnedName) ||
    input.review?.decision !== "match" ||
    input.review.confidence < 0.75 ||
    input.review.conflicts.length > 0
  ) return false;
  return input.review.corroboratingSignals.some(
    (signal) => !["name", "interests", "location"].includes(signal.category),
  );
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

  constructor(private readonly fetchProfile: typeof smartFetch = smartFetch) {}

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

    const requestedLinkedInIdentity = selectLinkedInIdentityForLookup(
      context.person.identities,
    );
    const linkedInUrl = requestedLinkedInIdentity
      ? normalizeLinkedInMemberUrl(requestedLinkedInIdentity.profileUrl)
      : null;
    const name = sanitizePlainText(context.person.displayName, 200);
    const fuzzyAnchor = licensedFuzzyLookupAnchor(
      context.person,
      context.evidenceEvents,
    );
    const minLikelihood = Math.min(
      10,
      Math.max(1, Math.floor(asNumber(context.settings.options?.minLikelihood, DEFAULT_MIN_LIKELIHOOD))),
    );
    const rosterCandidate = context.person.identities.some(
      (identity) => identity.provider === "roster-page",
    );
    const effectiveMinLikelihood = !linkedInUrl && rosterCandidate
      ? Math.min(minLikelihood, ROSTER_MIN_LIKELIHOOD)
      : minLikelihood;

    const endpoint = new URL(ENRICH_ENDPOINT);
    // Every fuzzy result still passes through the grounded identity reviewer.
    // Honor the configured provider threshold so a strong work, education, or
    // project overlap can recover people that PDL scores below 9.
    endpoint.searchParams.set("min_likelihood", String(effectiveMinLikelihood));
    if (linkedInUrl) {
      endpoint.searchParams.set("profile", linkedInUrl);
    } else {
      // Fuzzy successful matches are billed before our identity model can
      // reject them. Operators can disable them entirely, but the bounded
      // default keeps LinkedIn recovery available for well-anchored people.
      if (process.env.PDL_ALLOW_FUZZY_LOOKUPS === "false") return null;
      // A fuzzy lookup needs a plausible human name plus at least one
      // corroborating anchor, or common names would bill for wrong people.
      if (
        name.split(/\s+/).filter(Boolean).length < 2 ||
        !Object.keys(fuzzyAnchor).length
      ) return null;
      endpoint.searchParams.set("name", name);
      for (const [key, value] of Object.entries(fuzzyAnchor)) {
        endpoint.searchParams.set(key, value);
      }
    }

    const budget = await consumeProviderDailyBudget("people-data-labs");
    if (!budget.allowed) {
      return {
        events: [],
        warnings: [`People Data Labs daily request budget is exhausted; it resets at ${budget.resetAt}.`],
        retryAfter: budget.resetAt,
      };
    }

    const response = await this.fetchProfile(endpoint.toString(), {
      headers: { accept: "application/json", "x-api-key": apiKey },
      rateLimitPerSecond: 1,
      timeoutMs: 12_000,
      retries: 0,
      maxBytes: 2_000_000,
      signal: context.signal,
    });
    // 404 is the provider's unbilled no-match answer, not a failure.
    if (response.status === 404) return { events: [] };
    if (response.status === 402) {
      throw new Error("People Data Labs account credits are exhausted (HTTP 402)");
    }
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
    const trustedAlternateNames = (context.person.alternateNames ?? [])
      .filter((alternate) => alternate.confidence >= 0.7)
      .map((alternate) => alternate.name);
    const nameCorresponds = [name, ...trustedAlternateNames].some((knownName) =>
      namesRoughlyMatch(profile.fullName, knownName)
    );
    const exact = isResolvedExactLinkedInMatch({
      alternateNames: trustedAlternateNames,
      identity: requestedLinkedInIdentity,
      requestedName: name,
      returnedName: profile.fullName,
      returnedUrl: profile.linkedInUrl,
    });
    let modelReview: IdentityMatchDecision | null = null;
    if (!exact) {
      modelReview = await reviewIdentityEvidenceMatch({
        person: context.person,
        evidenceEvents: context.evidenceEvents ?? [],
        observed: {
          url: profile.linkedInUrl ?? context.person.sourceUrl,
          title: profile.fullName,
          description: profile.headline,
          content: describeLicensedProfile(profile),
        },
        signal: context.signal,
      });
    }
    if (!nameCorresponds && modelReview?.decision !== "match") {
      return {
        events: [],
        warnings: [`A licensed match for ${name} was discarded because the returned name did not correspond.`],
      };
    }
    const groundedRosterMatch = isGroundedRosterLicensedMatch({
      person: context.person,
      requestedName: name,
      returnedName: profile.fullName,
      likelihood,
      review: modelReview,
    });
    const modelMatched = modelReview?.decision === "match" || groundedRosterMatch;
    const modelFlagged = Boolean(modelReview && !modelMatched);
    const modelConfidence = modelReview?.confidence ?? 0;
    const profileAccepted = shouldBindLicensedProfileIdentity(
      exact,
      modelReview?.decision,
      groundedRosterMatch,
    );

    const linkedInIdentity = profile.linkedInUrl
      ? [{
          provider: "linkedin-manual" as const,
          externalId: stableHash(profile.linkedInUrl),
          profileUrl: profile.linkedInUrl,
          username: new URL(profile.linkedInUrl).pathname.split("/").filter(Boolean).at(-1),
          // The URL came from PDL's provider response. Bind it when the lookup
          // was exact or when the grounded identity review accepted the match;
          // review/reject outcomes must remain detached hypotheses.
          verified: profileAccepted,
          confidence: exact
            ? 0.95
            : modelMatched
              ? Math.min(0.9, modelConfidence)
              : clamp(likelihood / 10, 0, 0.75),
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
      headline: profileAccepted
        ? context.person.headline || profile.headline
        : context.person.headline,
      biography: profileAccepted
        ? context.person.biography || profile.summary
        : context.person.biography,
      location: profileAccepted
        ? context.person.location || profile.location
        : context.person.location,
      affiliations: profileAccepted
        ? [
            ...new Set([...(context.person.affiliations ?? []), ...profile.affiliations]),
          ].slice(0, 12)
        : context.person.affiliations,
    };

    const modelDecisionTag = modelReview
      ? modelMatched
        ? "model-corroborated-identity"
        : modelReview.decision === "review"
          ? "model-identity-review"
          : "model-identity-conflict"
      : null;
    const confidence = exact
      ? 0.92
      : modelMatched
        ? Math.min(0.9, Math.max(0.8, modelConfidence))
        : modelFlagged
          ? modelReview?.decision === "reject"
            ? Math.min(0.3, modelConfidence)
            : Math.min(0.64, Math.max(0.35, modelConfidence))
          : clamp(0.35 + likelihood / 20, 0, 0.75);

    return {
      events: [
        createDiscoveryEvent({
          source: this.kind,
          sourceExternalId: stableHash(profile.linkedInUrl ?? name, exact ? "profile" : "fuzzy"),
          type: "profile_observed",
          title: exact
            ? `${context.person.displayName}'s licensed work history was imported`
            : modelMatched
              ? `${context.person.displayName}'s licensed work history was corroborated`
              : modelReview?.decision === "reject"
                ? `A conflicting licensed profile for ${context.person.displayName} was flagged`
                : `A likely work history for ${context.person.displayName} was licensed for review`,
          description: describeLicensedProfile(profile) || profile.headline,
          // A provider record is independently inspectable provider evidence
          // even when PDL did not return the underlying LinkedIn member URL.
          sourceUrl: profile.linkedInUrl ?? PDL_EVIDENCE_URL,
          person,
          tags: [
            "licensed-data",
            exact ? "verified-provider-subject" : modelDecisionTag ?? "requires-corroboration",
            ...(!exact && !modelMatched ? ["requires-corroboration"] : []),
          ],
          raw: {
            provider: "people-data-labs",
            likelihood,
            matchedBy: exact
              ? "linkedin-profile"
              : modelMatched
                ? groundedRosterMatch
                  ? "provider-and-model-corroborated-roster"
                  : "model-corroborated-evidence"
                : "name-and-anchor-review",
            identityReview: modelReview ?? undefined,
            identityModel: modelReview
              ? identityMatchModelName()
              : undefined,
            identityPromptVersion: modelReview ? "identity-evidence-v2" : undefined,
            retrievedAt: context.now.toISOString(),
            contactFieldsStored: false,
          },
          confidence,
          now: context.now,
        }),
      ],
    };
  }
}
