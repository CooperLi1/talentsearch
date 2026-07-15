import { sanitizePlainText } from "./security";

/**
 * Returns the canonical 16-character ORCID only when its ISO 7064 checksum is
 * valid. Provider payloads commonly alternate between bare IDs and profile
 * URLs, so connector identity matching must normalize both forms identically.
 */
export function normalizeOrcid(value: unknown): string | undefined {
  const candidate = sanitizePlainText(value, 100)
    .replace(/^https?:\/\/(?:www\.)?orcid\.org\//i, "")
    .replace(/\/$/, "")
    .toUpperCase();
  if (!/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/.test(candidate)) return undefined;

  const digits = candidate.replaceAll("-", "");
  let total = 0;
  for (const digit of digits.slice(0, 15)) total = (total + Number(digit)) * 2;
  const remainder = (12 - (total % 11)) % 11;
  const expected = remainder === 10 ? "X" : String(remainder);
  return digits.at(-1) === expected ? candidate : undefined;
}

export function orcidProfileUrl(value: unknown): string | undefined {
  const orcid = normalizeOrcid(value);
  return orcid ? `https://orcid.org/${orcid}` : undefined;
}
