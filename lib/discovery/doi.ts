import { sanitizePlainText } from "./security";
import type { ExternalIdentity } from "./types";

export function normalizeDoi(value: unknown): string | undefined {
  const candidate = sanitizePlainText(value, 500)
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .trim()
    .toLocaleLowerCase("en-US");
  return /^10\.\d{4,9}\/\S+$/.test(candidate) ? candidate : undefined;
}

/**
 * A DOI plus author position identifies one publisher-declared authorship.
 * It is intentionally not a global person ID, but it safely joins observations
 * of the same paper across scholarly indexes without relying on a name alone.
 */
export function doiAuthorshipIdentity(
  value: unknown,
  authorIndex: number,
): ExternalIdentity | undefined {
  const doi = normalizeDoi(value);
  if (!doi || !Number.isSafeInteger(authorIndex) || authorIndex < 0) return undefined;
  return {
    provider: "doi-authorship",
    externalId: `${doi}#author-${authorIndex}`,
    profileUrl: `https://doi.org/${doi}`,
    verified: true,
    confidence: 0.98,
    proof: "provider-api",
    proofSourceUrl: `https://doi.org/${doi}`,
  };
}

export function parseDoiAuthorshipIdentity(value: unknown): {
  doi: string;
  authorIndex: number;
} | undefined {
  const candidate = sanitizePlainText(value, 600);
  const match = candidate.match(/^(10\.\d{4,9}\/\S+)#author-(\d+)$/i);
  if (!match) return undefined;
  const doi = normalizeDoi(match[1]);
  const authorIndex = Number(match[2]);
  if (!doi || !Number.isSafeInteger(authorIndex) || authorIndex < 0) return undefined;
  return { doi, authorIndex };
}
