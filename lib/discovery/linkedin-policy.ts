const LINKEDIN_MEMBER_PATH = /^\/in\/([A-Za-z0-9_-]{2,150})\/?$/u;

export function normalizeLinkedInMemberUrl(value: unknown): string | null {
  try {
    const url = new URL(String(value ?? ""));
    const hostname = url.hostname.replace(/^www\./i, "").replace(/\.$/, "").toLowerCase();
    const match = url.pathname.match(LINKEDIN_MEMBER_PATH);
    if (url.protocol !== "https:" || hostname !== "linkedin.com" || !match) return null;
    return `https://www.linkedin.com/in/${match[1]}`;
  } catch {
    return null;
  }
}

/**
 * Direct LinkedIn page access is disabled by default. A future approved
 * integration must require both an explicit data-use approval and a separately
 * configured approved API endpoint; a token or URL alone is never sufficient.
 */
export function isLinkedInDirectAccessApproved(
  environment: Record<string, string | undefined> = process.env,
) {
  if (environment.LINKEDIN_DIRECT_ACCESS_APPROVED !== "true") return false;
  if (!environment.LINKEDIN_APPROVED_API_TOKEN?.trim()) return false;
  try {
    const url = new URL(environment.LINKEDIN_APPROVED_API_BASE_URL ?? "");
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function assertLinkedInDirectAccessApproved() {
  if (!isLinkedInDirectAccessApproved()) {
    throw new Error("Direct LinkedIn access is disabled until an approved integration is configured.");
  }
}
