import { isIP } from "node:net";

import { smartFetch } from "../http";
import { stableHash } from "../idempotency";
import { normalizeLinkedInMemberUrl } from "../linkedin-policy";
import { isBlockedIp, sanitizePlainText } from "../security";
import type {
  ConnectorRunContext,
  ConnectorRunResult,
  DiscoveryConnector,
  DiscoveryEvent,
  ExternalIdentity,
  PersonObservation,
} from "../types";
import { createDiscoveryEvent, mapLimit } from "./shared";

const EXA_SEARCH_ENDPOINT = "https://api.exa.ai/search";
const MAX_QUERIES = 8;
const MAX_RESULTS = 100;

type ExaCompany = { id?: unknown; name?: unknown };
type ExaInstitution = { id?: unknown; name?: unknown };
type ExaDates = { from?: unknown; to?: unknown };
type ExaWork = {
  title?: unknown;
  location?: unknown;
  dates?: ExaDates;
  company?: ExaCompany;
};
type ExaEducation = {
  degree?: unknown;
  dates?: ExaDates;
  institution?: ExaInstitution;
};
type ExaPersonProperties = {
  name?: unknown;
  location?: unknown;
  workHistory?: unknown;
  educationHistory?: unknown;
};
type ExaEntity = {
  id?: unknown;
  type?: unknown;
  version?: unknown;
  properties?: ExaPersonProperties;
};
type ExaResult = {
  id?: unknown;
  title?: unknown;
  url?: unknown;
  highlights?: unknown;
  entities?: unknown;
};
type ExaResponse = {
  requestId?: unknown;
  results?: unknown;
  costDollars?: { total?: unknown };
};

function redactContactDetails(value: unknown, maximum = 3_000) {
  return sanitizePlainText(value, maximum)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[contact redacted]")
    .replace(/(?:\+?\d[\d\s().-]{7,}\d)/gu, "[contact redacted]");
}

function looksLikeHumanName(value: string) {
  const parts = sanitizePlainText(value, 200).split(/\s+/u).filter(Boolean);
  if (parts.length < 2 || parts.length > 7) return false;
  return parts.every(
    (part) =>
      /^[\p{L}\p{M}][\p{L}\p{M}'’.·-]*[,]?$/u.test(part) &&
      /\p{L}{2}/u.test(part),
  );
}

function safeResultUrl(value: unknown) {
  try {
    const url = new URL(sanitizePlainText(value, 2_000));
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return "";
    const hostname = url.hostname.replace(/^\[|\]$/gu, "").replace(/\.$/u, "").toLowerCase();
    if (
      !hostname ||
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal")
    ) {
      return "";
    }
    const mappedIpv4 = hostname.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/u)?.[1];
    if (
      (isIP(hostname) !== 0 && isBlockedIp(hostname)) ||
      (mappedIpv4 && isBlockedIp(mappedIpv4))
    ) {
      return "";
    }
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function yearOf(value: unknown) {
  return sanitizePlainText(value, 30).match(/^(\d{4})/u)?.[1] ?? "";
}

function spanOf(value: unknown) {
  const dates = value && typeof value === "object" ? (value as ExaDates) : {};
  const from = yearOf(dates.from);
  const to = yearOf(dates.to);
  if (!from && !to) return "";
  return `${from || "?"}–${to || "present"}`;
}

function workLine(value: unknown) {
  const work = value && typeof value === "object" ? (value as ExaWork) : {};
  const title = sanitizePlainText(work.title, 250);
  const company = sanitizePlainText(work.company?.name, 250);
  if (!title && !company) return "";
  const span = spanOf(work.dates);
  return [
    `${title || "Worked"}${company ? ` at ${company}` : ""}`,
    span ? `(${span})` : "",
  ].filter(Boolean).join(" ");
}

function educationLine(value: unknown) {
  const education = value && typeof value === "object" ? (value as ExaEducation) : {};
  const institution = sanitizePlainText(education.institution?.name, 250);
  if (!institution) return "";
  const degree = sanitizePlainText(education.degree, 250);
  const span = spanOf(education.dates);
  return [
    `${degree || "Studied"} at ${institution}`,
    span ? `(${span})` : "",
  ].filter(Boolean).join(" ");
}

function startOfUtcWeek(now: Date) {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - daysSinceMonday);
  return date.toISOString();
}

function personEntities(result: ExaResult) {
  const entities = Array.isArray(result.entities)
    ? result.entities.filter((value): value is ExaEntity => Boolean(value && typeof value === "object"))
    : [];
  const people = entities.filter(
    (entity) => sanitizePlainText(entity.type, 30).toLowerCase() === "person",
  );
  if (people.length || entities.length) return people;

  // Older People Search responses may expose only a result ID and title.
  // The category itself is person-scoped, so retain that bounded fallback at
  // lower confidence instead of silently dropping every legacy response.
  return [{
    id: result.id,
    type: "person",
    properties: { name: result.title },
  }] satisfies ExaEntity[];
}

function uniqueAffiliations(properties: ExaPersonProperties) {
  const employers = (Array.isArray(properties.workHistory) ? properties.workHistory : [])
    .map((value) => {
      const work = value && typeof value === "object" ? (value as ExaWork) : {};
      return sanitizePlainText(work.company?.name, 250);
    });
  const institutions = (
    Array.isArray(properties.educationHistory) ? properties.educationHistory : []
  ).map((value) => {
    const education = value && typeof value === "object" ? (value as ExaEducation) : {};
    return sanitizePlainText(education.institution?.name, 250);
  });
  return [...new Set([...employers, ...institutions].filter(Boolean))].slice(0, 12);
}

function currentHeadline(properties: ExaPersonProperties) {
  const work = (Array.isArray(properties.workHistory) ? properties.workHistory : [])
    .filter((value): value is ExaWork => Boolean(value && typeof value === "object"));
  const current = work.find((item) => !sanitizePlainText(item.dates?.to, 30)) ?? work[0];
  if (!current) return undefined;
  const title = sanitizePlainText(current.title, 250);
  const company = sanitizePlainText(current.company?.name, 250);
  return title ? `${title}${company ? ` at ${company}` : ""}` : company || undefined;
}

function profileDescription(properties: ExaPersonProperties, result: ExaResult) {
  const work = (Array.isArray(properties.workHistory) ? properties.workHistory : [])
    .map(workLine)
    .filter(Boolean)
    .slice(0, 8);
  const education = (
    Array.isArray(properties.educationHistory) ? properties.educationHistory : []
  ).map(educationLine).filter(Boolean).slice(0, 4);
  const highlights = (Array.isArray(result.highlights) ? result.highlights : [])
    .map((value) => redactContactDetails(value, 800))
    .filter(Boolean)
    .slice(0, 3);
  return redactContactDetails([
    work.length ? `Work history: ${work.join("; ")}` : "",
    education.length ? `Education: ${education.join("; ")}` : "",
    highlights.length ? `Search match: ${highlights.join(" ")}` : "",
  ].filter(Boolean).join("\n"), 4_000);
}

export function parseExaPeopleResponse(
  payload: ExaResponse,
  input: { query: string; now: Date },
): DiscoveryEvent[] {
  const results = Array.isArray(payload.results)
    ? payload.results.filter((value): value is ExaResult => Boolean(value && typeof value === "object"))
    : [];
  const occurredAt = startOfUtcWeek(input.now);
  const queryHash = stableHash("exa-people-query", sanitizePlainText(input.query, 500));
  const requestId = sanitizePlainText(payload.requestId, 200);
  const events: DiscoveryEvent[] = [];

  for (const result of results) {
    const sourceUrl = safeResultUrl(result.url);
    if (!sourceUrl) continue;
    for (const entity of personEntities(result)) {
      const entityId = sanitizePlainText(entity.id, 500);
      const properties =
        entity.properties && typeof entity.properties === "object" ? entity.properties : {};
      const displayName = sanitizePlainText(properties.name || result.title, 200);
      if (!entityId || !looksLikeHumanName(displayName)) continue;

      const linkedInUrl = normalizeLinkedInMemberUrl(sourceUrl);
      const identities: ExternalIdentity[] = [{
        provider: "exa-people",
        externalId: entityId,
        profileUrl: sourceUrl,
        verified: true,
        confidence: 0.88,
        proof: "provider-api",
        proofSourceUrl: sourceUrl,
      }];
      if (linkedInUrl) {
        identities.push({
          provider: "linkedin-manual",
          externalId: stableHash(linkedInUrl),
          profileUrl: linkedInUrl,
          username: new URL(linkedInUrl).pathname.split("/").filter(Boolean).at(-1),
          verified: false,
          confidence: 0.75,
          proof: "provider-api",
          proofSourceUrl: sourceUrl,
        });
      }
      const person: PersonObservation = {
        displayName,
        identities,
        headline: currentHeadline(properties),
        biography: profileDescription(properties, result) || undefined,
        location: sanitizePlainText(properties.location, 300) || undefined,
        affiliations: uniqueAffiliations(properties),
        sourceUrl,
      };
      const structured = Boolean(
        Array.isArray(result.entities) &&
        sanitizePlainText(entity.type, 30).toLowerCase() === "person",
      );
      events.push(createDiscoveryEvent({
        source: "exa-people",
        sourceExternalId: entityId,
        type: "profile_observed",
        title: `Exa surfaced ${displayName} for technical-talent discovery`,
        description: person.biography,
        occurredAt,
        sourceUrl,
        person,
        tags: [
          "exa-people-discovery",
          "aggregated-professional-profile",
          "requires-independent-verification",
        ],
        raw: {
          exaEntityId: entityId,
          entityVersion: sanitizePlainText(entity.version, 100) || undefined,
          queryHash,
          requestId: requestId || undefined,
          contactFieldsStored: false,
        },
        confidence: structured ? 0.78 : 0.68,
        now: input.now,
      }));
    }
  }
  return events;
}

function interleave<T>(groups: T[][]) {
  const result: T[] = [];
  const maximum = Math.max(0, ...groups.map((group) => group.length));
  for (let index = 0; index < maximum; index += 1) {
    for (const group of groups) {
      if (group[index]) result.push(group[index]);
    }
  }
  return result;
}

export class ExaPeopleConnector implements DiscoveryConnector {
  readonly kind = "exa-people" as const;
  readonly displayName = "Exa people discovery";

  async discover(context: ConnectorRunContext): Promise<ConnectorRunResult> {
    const apiKey = process.env.EXA_API_KEY?.trim();
    if (!apiKey) {
      return { events: [], warnings: ["EXA_API_KEY is not configured."] };
    }
    const queries = [...new Set(
      (context.settings.queries ?? [])
        .map((query) => sanitizePlainText(query, 500))
        .filter(Boolean),
    )].slice(0, MAX_QUERIES);
    if (!queries.length) {
      return { events: [], warnings: ["Add at least one Exa people search before running discovery."] };
    }

    const maximum = Math.min(
      MAX_RESULTS,
      Math.max(1, Math.floor(context.settings.maxItems ?? 80)),
    );
    const perQuery = Math.min(MAX_RESULTS, Math.max(1, Math.ceil(maximum / queries.length)));
    const warnings: string[] = [];
    const groups = await mapLimit(queries, 2, async (query, index) => {
      try {
        const response = await smartFetch(EXA_SEARCH_ENDPOINT, {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            query,
            category: "people",
            type: "auto",
            numResults: perQuery,
            moderation: true,
            contents: { highlights: { maxCharacters: 1_200 } },
          }),
          rateLimitPerSecond: 1,
          timeoutMs: 15_000,
          retries: 1,
          maxBytes: 5_000_000,
          signal: context.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return parseExaPeopleResponse((await response.json()) as ExaResponse, {
          query,
          now: context.now,
        });
      } catch (error) {
        warnings.push(
          `Exa people search ${index + 1} failed: ${
            error instanceof Error ? sanitizePlainText(error.message, 200) : "unknown error"
          }`,
        );
        return [];
      }
    });

    const byKey = new Map<string, DiscoveryEvent>();
    for (const event of interleave(groups)) {
      const previous = byKey.get(event.idempotencyKey);
      if (!previous || previous.confidence < event.confidence) {
        byKey.set(event.idempotencyKey, event);
      }
      if (byKey.size >= maximum) break;
    }
    return {
      events: [...byKey.values()],
      warnings,
      cursor: {
        completedAt: context.now.toISOString(),
        queryCount: queries.length,
        resultCount: byKey.size,
      },
    };
  }
}
