import {
  reviewIdentityEvidenceMatch,
  type IdentityMatchDecision,
} from "@/lib/ai/identity-match";
import type {
  DiscoveryEvent,
  IdentityCandidate,
  IdentityDecision,
  PersonObservation,
} from "./types";

function normalizeName(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeOrganization(value: string) {
  return normalizeName(value).replace(/\b(university|college|inc|llc|ltd|lab|laboratory)\b/g, "").trim();
}

function normalizeUrl(value?: string) {
  if (!value) return "";
  try {
    const url = new URL(value.startsWith("http") ? value : `https://${value}`);
    return `${url.hostname.replace(/^www\./, "").toLowerCase()}${url.pathname.replace(/\/$/, "")}`;
  } catch {
    return value.toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
  }
}

function diceSimilarity(left: string, right: string) {
  if (left === right) return 1;
  if (left.length < 2 || right.length < 2) return 0;
  const pairs = new Map<string, number>();
  for (let index = 0; index < left.length - 1; index += 1) {
    const pair = left.slice(index, index + 2);
    pairs.set(pair, (pairs.get(pair) ?? 0) + 1);
  }
  let overlap = 0;
  for (let index = 0; index < right.length - 1; index += 1) {
    const pair = right.slice(index, index + 2);
    const count = pairs.get(pair) ?? 0;
    if (count > 0) {
      pairs.set(pair, count - 1);
      overlap += 1;
    }
  }
  return (2 * overlap) / (left.length + right.length - 2);
}

function overlap(left: string[] = [], right: string[] = []) {
  const a = new Set(left.map(normalizeOrganization).filter(Boolean));
  const b = new Set(right.map(normalizeOrganization).filter(Boolean));
  if (!a.size || !b.size) return false;
  return [...a].some((value) => b.has(value));
}

function compareIdentity(
  observation: PersonObservation,
  candidate: IdentityCandidate,
): { score: number; durable: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const observedByProvider = new Map(
    observation.identities.map((identity) => [
      `${identity.provider}:${identity.externalId.toLocaleLowerCase("en-US")}`,
      identity,
    ]),
  );
  const exact = candidate.identities.find((identity) =>
    observedByProvider.has(
      `${identity.provider}:${identity.externalId.toLocaleLowerCase("en-US")}`,
    ),
  );
  const observedExact = exact
    ? observedByProvider.get(
        `${exact.provider}:${exact.externalId.toLocaleLowerCase("en-US")}`,
      )
    : undefined;
  if (exact && observedExact) {
    const verifiedAssociation =
      exact.verified !== false && observedExact.verified === true;
    return {
      score: verifiedAssociation ? 1 : 0.92,
      durable: verifiedAssociation,
      reasons: [
        verifiedAssociation
          ? `Exact ${exact.provider} identifier`
          : `Unverified ${exact.provider} identifier claim`,
      ],
    };
  }

  if (observation.emailHash && candidate.emailHash === observation.emailHash) {
    return { score: 0.995, durable: true, reasons: ["Exact privacy-preserving email hash"] };
  }

  const observedName = normalizeName(observation.displayName);
  const candidateName = normalizeName(candidate.displayName);
  const nameSimilarity = diceSimilarity(observedName, candidateName);
  let score = nameSimilarity * 0.38;
  if (nameSimilarity === 1) reasons.push("Exact normalized name");
  else if (nameSimilarity > 0.82) reasons.push("Very similar name");

  const observedWebsite = normalizeUrl(observation.websiteUrl);
  const candidateWebsite = normalizeUrl(candidate.websiteUrl);
  const sameWebsite = Boolean(observedWebsite && observedWebsite === candidateWebsite);
  if (sameWebsite) {
    score += 0.48;
    reasons.push("Exact personal website");
  }
  if (overlap(observation.affiliations, candidate.affiliations)) {
    score += 0.24;
    reasons.push("Shared affiliation");
  }
  if (
    observation.location &&
    candidate.location &&
    normalizeName(observation.location) === normalizeName(candidate.location)
  ) {
    score += 0.08;
    reasons.push("Shared location");
  }
  return {
    score: Math.min(1, score),
    durable: sameWebsite && nameSimilarity > 0.82,
    reasons,
  };
}

function reviewableIdentityCandidates(
  observation: PersonObservation,
  candidates: IdentityCandidate[],
) {
  return candidates
    .map((candidate) => ({ candidate, ...compareIdentity(observation, candidate) }))
    .filter((item) =>
      item.score >= 0.3 &&
      item.reasons.some((reason) =>
        reason === "Exact normalized name" || reason === "Very similar name" ||
        reason.startsWith("Unverified "),
      )
    )
    .sort((left, right) => right.score - left.score)
    .slice(0, 2);
}

export function resolveIdentity(
  observation: PersonObservation,
  candidates: IdentityCandidate[],
): IdentityDecision {
  const ranked = candidates
    .map((candidate) => ({ candidate, ...compareIdentity(observation, candidate) }))
    .sort((left, right) => right.score - left.score);
  const best = ranked[0];
  if (!best) {
    return { action: "create", confidence: 0.9, reasons: ["No plausible existing identity"] };
  }
  if (best.score >= 0.92 && best.durable) {
    return {
      action: "match",
      candidateId: best.candidate.id,
      confidence: best.score,
      reasons: best.reasons,
    };
  }
  const plausible = ranked.filter((item) => item.score >= 0.52).slice(0, 5);
  if (plausible.length) {
    return {
      action: "review",
      possibleCandidateIds: plausible.map((item) => item.candidate.id),
      confidence: best.score,
      reasons: [
        ...best.reasons,
        "No durable identifier; same-name records are never auto-merged",
      ],
    };
  }
  return {
    action: "create",
    confidence: Math.max(0.55, 1 - best.score),
    reasons: ["No candidate passed the conservative review threshold"],
  };
}

type IdentityEvidenceReviewer = typeof reviewIdentityEvidenceMatch;

export async function resolveIdentityWithEvidence(
  input: {
    observation: PersonObservation;
    candidates: IdentityCandidate[];
    event: DiscoveryEvent;
    signal?: AbortSignal;
  },
  reviewer: IdentityEvidenceReviewer = reviewIdentityEvidenceMatch,
): Promise<IdentityDecision> {
  const deterministic = resolveIdentity(input.observation, input.candidates);
  if (deterministic.action === "match") return deterministic;
  const reviewable = reviewableIdentityCandidates(input.observation, input.candidates);
  if (!reviewable.length || input.signal?.aborted) return deterministic;

  const reviewed: Array<{
    candidate: IdentityCandidate;
    review: IdentityMatchDecision | null;
  }> = [];
  for (const { candidate } of reviewable) {
    const candidatePerson = candidate.person ?? {
      displayName: candidate.displayName,
      identities: candidate.identities,
      affiliations: candidate.affiliations,
      location: candidate.location,
      websiteUrl: candidate.websiteUrl,
      sourceUrl: candidate.websiteUrl || candidate.identities[0]?.profileUrl || input.event.sourceUrl,
    };
    reviewed.push({
      candidate,
      review: await reviewer({
        person: candidatePerson,
        evidenceEvents: candidate.evidenceEvents ?? [],
        observed: {
          url: input.event.sourceUrl,
          title: input.event.title,
          description: input.event.description,
          content: JSON.stringify({
            name: input.observation.displayName,
            headline: input.observation.headline,
            biography: input.observation.biography,
            affiliations: input.observation.affiliations,
            location: input.observation.location,
            explicitCareerStage: input.observation.explicitCareerStage,
            identities: input.observation.identities.map((identity) => ({
              provider: identity.provider,
              username: identity.username,
              profileUrl: identity.profileUrl,
              verified: identity.verified === true,
            })),
          }),
        },
        signal: input.signal,
      }),
    });
    if (input.signal?.aborted) break;
  }

  if (!reviewed.some((item) => item.review)) return deterministic;
  const matches = reviewed.filter((item) => item.review?.decision === "match");
  const unresolved = reviewed.filter((item) =>
    !item.review || item.review.decision === "review",
  );
  if (matches.length === 1 && unresolved.length === 0) {
    const selected = matches[0]!;
    return {
      action: "match",
      candidateId: selected.candidate.id,
      confidence: selected.review!.confidence,
      reasons: [
        "Model-corroborated public identity evidence",
        selected.review!.summary,
        ...selected.review!.corroboratingSignals.map((signal) =>
          `${signal.category}: ${signal.candidateEvidence} ↔ ${signal.observedEvidence}`
        ),
      ].slice(0, 8),
    };
  }
  if (matches.length || unresolved.length) {
    const possible = [...matches, ...unresolved];
    return {
      action: "review",
      possibleCandidateIds: possible.map((item) => item.candidate.id),
      confidence: Math.max(...possible.map((item) => item.review?.confidence ?? 0.5)),
      reasons: [
        "Model review found plausible identity overlap but not one unambiguous match",
        ...possible.flatMap((item) => item.review?.conflicts.map((conflict) =>
          `${conflict.category} conflict: ${conflict.candidateEvidence} ↔ ${conflict.observedEvidence}`
        ) ?? []),
      ].slice(0, 8),
    };
  }
  return deterministic;
}
