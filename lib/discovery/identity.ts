import type {
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
