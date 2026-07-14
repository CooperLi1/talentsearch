import { fetchJson } from "../http";
import { sanitizePlainText } from "../security";
import {
  analyzeRepositoryInventory,
  type RepositoryComplexityAnalysis,
  type RepositoryTreeEntry,
} from "../technical-complexity";
import type {
  ConnectorEnrichmentContext,
  ConnectorRunContext,
  ConnectorRunResult,
  DiscoveryConnector,
  DiscoveryEvent,
  PersonObservation,
} from "../types";
import { asNumber, createDiscoveryEvent } from "./shared";

type GitLabNamespace = {
  id: number;
  name: string;
  path: string;
  kind: string;
  web_url: string;
  avatar_url?: string | null;
};

type GitLabProject = {
  id: number;
  name: string;
  path_with_namespace: string;
  description?: string | null;
  web_url: string;
  star_count: number;
  forks_count: number;
  created_at: string;
  last_activity_at: string;
  topics?: string[];
  default_branch?: string | null;
  visibility?: string;
  namespace: GitLabNamespace;
};

type GitLabUser = {
  id: number;
  username: string;
  name: string;
  state: string;
  avatar_url?: string | null;
  web_url: string;
  location?: string | null;
  bio?: string | null;
  organization?: string | null;
  website_url?: string | null;
};

async function gitLabJson<T>(
  url: string,
  input: { signal?: AbortSignal; allowToken?: boolean } = {},
) {
  const token = input.allowToken ? process.env.GITLAB_TOKEN?.trim() : undefined;
  try {
    return await fetchJson<T>(url, {
      headers: token ? { "private-token": token } : {},
      signal: input.signal,
      rateLimitPerSecond: 2,
    });
  } catch (error) {
    // A read token can lose or narrow access over time. Retry without it only
    // when GitLab says permission was denied so public enrichment still works.
    if (token && error instanceof Error && /HTTP (?:401|403)\b/.test(error.message)) {
      return fetchJson<T>(url, { signal: input.signal, rateLimitPerSecond: 2 });
    }
    throw error;
  }
}

function namespacePerson(namespace: GitLabNamespace): PersonObservation {
  return {
    displayName: sanitizePlainText(namespace.name || namespace.path, 200),
    identities: [
      {
        provider: "gitlab",
        externalId: String(namespace.id),
        username: namespace.path,
        profileUrl: namespace.web_url,
        verified: true,
      },
    ],
    avatarUrl: namespace.avatar_url ?? undefined,
    sourceUrl: namespace.web_url,
  };
}

function projectEvent(
  project: GitLabProject,
  now: Date,
  analysis?: RepositoryComplexityAnalysis,
): DiscoveryEvent {
  const person = namespacePerson(project.namespace);
  return createDiscoveryEvent({
    source: "gitlab",
    sourceExternalId: String(project.id),
    type: project.star_count > 15 ? "project_momentum" : "project_created",
    title: `${person.displayName} built ${project.name}`,
    description: [
      project.description ?? undefined,
      analysis?.indicators.length
        ? `Technical-depth evidence: ${analysis.indicators.join("; ")}.`
        : undefined,
    ]
      .filter(Boolean)
      .join(" ") || undefined,
    occurredAt: project.last_activity_at ?? project.created_at,
    sourceUrl: project.web_url,
    person,
    metrics: {
      stars: asNumber(project.star_count),
      forks: asNumber(project.forks_count),
      momentum:
        (Math.log1p(asNumber(project.star_count)) + Math.log1p(asNumber(project.forks_count))) /
        40,
      technicalComplexity: analysis?.score ?? 0,
      technicalComplexityConfidence: analysis?.confidence ?? 0.15,
      authoredCodeRatio: analysis?.components.authoredCodeRatio ?? 0,
      testsAndCi: analysis?.components.testsAndCi ?? 0,
      systemsAndResearch: analysis?.components.systemsAndResearch ?? 0,
    },
    tags: project.topics,
    raw: analysis
      ? {
          technicalComplexity: {
            components: analysis.components,
            indicators: analysis.indicators,
            evidence: analysis.evidence,
          },
        }
      : undefined,
    confidence: analysis
      ? Math.min(0.97, 0.76 + analysis.confidence * 0.2)
      : project.namespace.kind === "user"
        ? 0.8
        : 0.55,
    now,
  });
}

export class GitLabConnector implements DiscoveryConnector {
  readonly kind = "gitlab" as const;
  readonly displayName = "GitLab";

  async discover(context: ConnectorRunContext): Promise<ConnectorRunResult> {
    const maxItems = Math.min(100, context.settings.maxItems ?? 30);
    const lookbackDays = Math.min(90, Math.max(1, context.settings.lookbackDays ?? 14));
    const lastActivityAfter = new Date(
      context.now.getTime() - lookbackDays * 86_400_000,
    ).toISOString();
    const queries = (
      context.settings.queries?.filter(Boolean) ?? ["ai", "robotics", "developer tools"]
    ).slice(0, 8);
    const events: DiscoveryEvent[] = [];
    const warnings: string[] = [];

    for (const query of queries) {
      const url = new URL("https://gitlab.com/api/v4/projects");
      url.searchParams.set("search", query);
      url.searchParams.set("order_by", "last_activity_at");
      url.searchParams.set("sort", "desc");
      url.searchParams.set("simple", "true");
      url.searchParams.set("visibility", "public");
      url.searchParams.set("active", "true");
      url.searchParams.set("last_activity_after", lastActivityAfter);
      url.searchParams.set("per_page", String(Math.ceil(maxItems / queries.length)));
      try {
        // Global discovery is always anonymous and public-only. An optional
        // token is reserved for the later, bounded enrichment pass.
        const projects = await gitLabJson<GitLabProject[]>(url.toString(), {
          signal: context.signal,
        });
        for (const project of projects) {
          if (project.namespace?.kind !== "user") continue;
          events.push(projectEvent(project, context.now));
        }
      } catch (error) {
        warnings.push(
          `GitLab query failed: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }
    }

    return {
      events: events.slice(0, maxItems),
      cursor: { since: context.now.toISOString() },
      warnings,
    };
  }

  async enrich(context: ConnectorEnrichmentContext): Promise<ConnectorRunResult | null> {
    const identity = context.person.identities.find(
      (item) => item.provider === "gitlab" && item.username,
    );
    if (!identity?.username) return null;
    const users = await gitLabJson<GitLabUser[]>(
      `https://gitlab.com/api/v4/users?username=${encodeURIComponent(identity.username)}`,
      { signal: context.signal, allowToken: true },
    );
    const user = users.find((item) => item.username === identity.username);
    if (!user) return null;
    const projects = await gitLabJson<GitLabProject[]>(
      `https://gitlab.com/api/v4/users/${user.id}/projects?order_by=last_activity_at&sort=desc&per_page=15`,
      { signal: context.signal, allowToken: true },
    );
    const publicProjects = projects.filter((project) => project.visibility === "public");
    const person: PersonObservation = {
      displayName: sanitizePlainText(user.name || user.username, 200),
      identities: [
        {
          provider: "gitlab",
          externalId: String(user.id),
          username: user.username,
          profileUrl: user.web_url,
          verified: true,
        },
      ],
      biography: user.bio ? sanitizePlainText(user.bio, 2_000) : undefined,
      headline: user.bio ? sanitizePlainText(user.bio, 500) : undefined,
      affiliations: user.organization ? [sanitizePlainText(user.organization, 300)] : undefined,
      location: user.location ? sanitizePlainText(user.location, 300) : undefined,
      avatarUrl: user.avatar_url ?? undefined,
      websiteUrl: user.website_url ?? undefined,
      sourceUrl: user.web_url,
    };
    const profile = createDiscoveryEvent({
      source: "gitlab",
      sourceExternalId: `user:${user.id}`,
      type: "profile_observed",
      title: `${person.displayName}'s open-source profile`,
      description: person.biography,
      sourceUrl: user.web_url,
      person,
      confidence: 0.98,
      now: context.now,
    });

    const hardConstraintKeywords = Array.isArray(context.settings.options?.complexityKeywords)
      ? context.settings.options.complexityKeywords
          .filter((item): item is string => typeof item === "string")
          .slice(0, 30)
      : [];
    const analyses = await Promise.all(
      publicProjects.slice(0, 3).map(async (project) => {
        try {
          const base = `https://gitlab.com/api/v4/projects/${project.id}`;
          const request = <T,>(url: string) =>
            gitLabJson<T>(url, {
              signal: context.signal,
              allowToken: true,
            });
          const [tree, languages, contributors, commits, releases] = await Promise.all([
            request<Array<{ path: string; type: string }>>(
              `${base}/repository/tree?recursive=true&per_page=100`,
            ),
            request<Record<string, number>>(`${base}/languages`).catch(() => ({})),
            request<Array<{ commits?: number }>>(
              `${base}/repository/contributors?per_page=100`,
            ).catch(() => []),
            request<unknown[]>(`${base}/repository/commits?per_page=100`).catch(() => []),
            request<unknown[]>(`${base}/releases?per_page=30`).catch(() => []),
          ]);
          return analyzeRepositoryInventory({
            tree: tree as RepositoryTreeEntry[],
            treeTruncated: tree.length >= 100,
            languages,
            contributors: contributors.map((item) => ({ contributions: item.commits ?? 0 })),
            commitCountSample: commits.length,
            releaseCountSample: releases.length,
            stars: project.star_count,
            forks: project.forks_count,
            description: project.description,
            hardConstraintKeywords,
          });
        } catch {
          return undefined;
        }
      }),
    );
    return {
      events: [
        profile,
        ...publicProjects.map((project, index) =>
          projectEvent(project, context.now, analyses[index]),
        ),
      ],
    };
  }
}
