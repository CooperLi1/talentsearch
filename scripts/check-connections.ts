import { isLinkedInDirectAccessApproved } from "../lib/discovery/linkedin-policy";

export {};

type CheckResult = { configured: boolean; ok: boolean; status: number | string };

async function request(
  url: string,
  options: RequestInit,
  accepted: number[] = [200],
): Promise<CheckResult> {
  try {
    const response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(15_000),
    });
    return { configured: true, ok: accepted.includes(response.status), status: response.status };
  } catch {
    return { configured: true, ok: false, status: "network_error" };
  }
}

async function main() {
  const checks: Record<string, CheckResult> = {};
  const supabaseUrl =
    process.env.SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  checks.supabase = supabaseUrl && serviceRoleKey
    ? await request(`${supabaseUrl}/rest/v1/workspaces?select=id&limit=1`, {
        headers: { apikey: serviceRoleKey, authorization: `Bearer ${serviceRoleKey}` },
      })
    : { configured: false, ok: false, status: "missing" };

  const openAiKey = process.env.OPENAI_API_KEY?.trim();
  checks.openai = openAiKey
    ? await request("https://api.openai.com/v1/models", {
        headers: { authorization: `Bearer ${openAiKey}` },
      })
    : { configured: false, ok: false, status: "missing" };

  const resendKey = process.env.RESEND_API_KEY?.trim();
  checks.resend = resendKey && resendKey.startsWith("re_")
    ? await request("https://api.resend.com/domains?limit=1", {
        headers: { authorization: `Bearer ${resendKey}` },
      })
    : {
        configured: Boolean(resendKey),
        ok: false,
        status: resendKey ? "invalid_format" : "missing",
      };

  const githubToken = process.env.GITHUB_TOKEN?.trim();
  checks.github = githubToken
    ? await request("https://api.github.com/user", {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${githubToken}`,
          "user-agent": "unfound-connection-check/1.0",
          "x-github-api-version": "2022-11-28",
        },
      })
    : { configured: false, ok: false, status: "missing" };

  const gitlabToken = process.env.GITLAB_TOKEN?.trim();
  checks.gitlab = gitlabToken
    ? await request("https://gitlab.com/api/v4/user", {
        headers: { "private-token": gitlabToken },
      })
    : { configured: false, ok: false, status: "missing" };

  checks.semanticScholar = {
    configured: Boolean(process.env.SEMANTIC_SCHOLAR_API_KEY?.trim()),
    ok: Boolean(process.env.SEMANTIC_SCHOLAR_API_KEY?.trim()),
    status: process.env.SEMANTIC_SCHOLAR_API_KEY?.trim() ? "configured" : "missing",
  };
  const openAlexKey = process.env.OPENALEX_API_KEY?.trim();
  checks.openAlex = openAlexKey
    ? await request(
        `https://api.openalex.org/rate-limit?api_key=${encodeURIComponent(openAlexKey)}`,
        {},
      )
    : { configured: false, ok: false, status: "missing" };
  checks.x = {
    configured: Boolean(process.env.X_BEARER_TOKEN?.trim()),
    ok:
      Boolean(process.env.X_BEARER_TOKEN?.trim()) &&
      process.env.X_DATA_USE_APPROVED === "true",
    status:
      process.env.X_DATA_USE_APPROVED === "true" ? "approved" : "awaiting_data_use_approval",
  };
  checks.brave = {
    configured: Boolean(process.env.BRAVE_SEARCH_API_KEY?.trim()),
    ok: Boolean(process.env.BRAVE_SEARCH_API_KEY?.trim()),
    status: process.env.BRAVE_SEARCH_API_KEY?.trim() ? "configured_not_charged" : "missing",
  };
  checks.linkedin = {
    configured: Boolean(
      process.env.LINKEDIN_APPROVED_API_BASE_URL?.trim() ||
      process.env.LINKEDIN_APPROVED_API_TOKEN?.trim(),
    ),
    ok: isLinkedInDirectAccessApproved(),
    status: isLinkedInDirectAccessApproved()
      ? "approved_profile_access"
      : "manual_and_public_locator_only",
  };

  console.log(JSON.stringify(checks, null, 2));
  if (Object.entries(checks).some(([name, result]) => !result.ok && !["supabase", "semanticScholar", "openAlex", "x", "linkedin"].includes(name))) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Connection checks failed");
  process.exitCode = 1;
});
