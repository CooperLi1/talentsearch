import { fetchJson } from "../http";
import { sanitizePlainText } from "../security";
import {
  analyzeGitHubRepositoryComplexity,
  type RepositoryComplexityAnalysis,
} from "../technical-complexity";
import type {
  ConnectorEnrichmentContext,
  ConnectorRunContext,
  ConnectorRunResult,
  DiscoveryConnector,
  DiscoveryEvent,
  ExternalIdentity,
  GraphEdge,
  PersonObservation,
} from "../types";
import { asNumber, createDiscoveryEvent } from "./shared";

type GitHubOwner = {
  id: number;
  login: string;
  avatar_url?: string;
  html_url: string;
  type?: string;
};

type GitHubRepository = {
  id: number;
  name: string;
  full_name: string;
  html_url: string;
  description?: string | null;
  created_at: string;
  updated_at: string;
  pushed_at?: string;
  stargazers_count: number;
  forks_count: number;
  open_issues_count?: number;
  language?: string | null;
  default_branch: string;
  size?: number;
  topics?: string[];
  owner: GitHubOwner;
};

type GitHubSearchResponse = {
  items?: GitHubRepository[];
};

type GitHubUser = GitHubOwner & {
  name?: string | null;
  bio?: string | null;
  location?: string | null;
  blog?: string | null;
  company?: string | null;
  followers?: number;
  following?: number;
  public_repos?: number;
  created_at?: string;
  updated_at?: string;
};

function githubHeaders(): HeadersInit {
  const token = process.env.GITHUB_TOKEN;
  return {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

function githubIdentity(owner: GitHubOwner): ExternalIdentity {
  return {
    provider: "github",
    externalId: String(owner.id),
    username: owner.login,
    profileUrl: owner.html_url,
    verified: true,
  };
}

function ownerObservation(owner: GitHubOwner): PersonObservation {
  return {
    displayName: sanitizePlainText(owner.login, 200),
    identities: [githubIdentity(owner)],
    avatarUrl: owner.avatar_url,
    sourceUrl: owner.html_url,
  };
}

function repositoryEvent(
  repo: GitHubRepository,
  now: Date,
  analysis?: RepositoryComplexityAnalysis,
): DiscoveryEvent {
  const tractionCorroboration =
    (Math.log1p(repo.stargazers_count) + Math.log1p(repo.forks_count)) / 40;
  return createDiscoveryEvent({
    source: "github",
    sourceExternalId: String(repo.id),
    type: repo.stargazers_count > 25 ? "project_momentum" : "project_created",
    title: `${repo.owner.login} built ${repo.name}`,
    description: [
      repo.description ?? undefined,
      analysis?.indicators.length
        ? `Technical-depth evidence: ${analysis.indicators.join("; ")}.`
        : undefined,
    ]
      .filter(Boolean)
      .join(" ") || undefined,
    occurredAt: repo.pushed_at ?? repo.updated_at ?? repo.created_at,
    sourceUrl: repo.html_url,
    person: ownerObservation(repo.owner),
    metrics: {
      stars: asNumber(repo.stargazers_count),
      forks: asNumber(repo.forks_count),
      openIssues: asNumber(repo.open_issues_count),
      momentum: tractionCorroboration,
      technicalComplexity: analysis?.score ?? 0,
      technicalComplexityConfidence: analysis?.confidence ?? 0.15,
      authoredCodeRatio: analysis?.components.authoredCodeRatio ?? 0,
      testsAndCi: analysis?.components.testsAndCi ?? 0,
      systemsAndResearch: analysis?.components.systemsAndResearch ?? 0,
    },
    tags: [repo.language ?? "", ...(repo.topics ?? [])].filter(Boolean),
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
      ? Math.min(0.98, 0.78 + analysis.confidence * 0.2)
      : repo.owner.type === "User"
        ? 0.82
        : 0.6,
    now,
  });
}

export class GitHubConnector implements DiscoveryConnector {
  readonly kind = "github" as const;
  readonly displayName = "GitHub";

  async discover(context: ConnectorRunContext): Promise<ConnectorRunResult> {
    const lookbackDays = Math.min(90, Math.max(1, context.settings.lookbackDays ?? 14));
    const since = new Date(context.now.getTime() - lookbackDays * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const maxItems = Math.min(100, Math.max(1, context.settings.maxItems ?? 35));
    const configuredQueries = context.settings.queries?.filter(Boolean) ?? [];
    const queries = configuredQueries.length
      ? configuredQueries
      : [`pushed:>=${since} stars:>=10 size:>5`, `created:>=${since} stars:>=5`];

    const events: DiscoveryEvent[] = [];
    const warnings: string[] = [];
    for (const query of queries.slice(0, 8)) {
      const search = new URL("https://api.github.com/search/repositories");
      search.searchParams.set("q", `${query} archived:false fork:false`);
      search.searchParams.set("sort", "updated");
      search.searchParams.set("order", "desc");
      search.searchParams.set("per_page", String(Math.ceil(maxItems / queries.length)));
      try {
        const result = await fetchJson<GitHubSearchResponse>(search.toString(), {
          headers: githubHeaders(),
          rateLimitPerSecond: process.env.GITHUB_TOKEN ? 4 : 0.5,
          signal: context.signal,
        });
        for (const repo of result.items ?? []) {
          if (repo.owner?.type && repo.owner.type !== "User") continue;
          events.push(repositoryEvent(repo, context.now));
        }
      } catch (error) {
        warnings.push(
          `GitHub query failed: ${error instanceof Error ? error.message : "unknown error"}`,
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
      (item) => item.provider === "github" && item.username,
    );
    if (!identity?.username) return null;
    const login = encodeURIComponent(identity.username);
    const user = await fetchJson<GitHubUser>(`https://api.github.com/users/${login}`, {
      headers: githubHeaders(),
      rateLimitPerSecond: process.env.GITHUB_TOKEN ? 4 : 0.5,
      signal: context.signal,
    });
    const repos = await fetchJson<GitHubRepository[]>(
      `https://api.github.com/users/${login}/repos?sort=pushed&direction=desc&per_page=12&type=owner`,
      {
        headers: githubHeaders(),
        rateLimitPerSecond: process.env.GITHUB_TOKEN ? 4 : 0.5,
        signal: context.signal,
      },
    );
    const person: PersonObservation = {
      displayName: sanitizePlainText(user.name || user.login, 200),
      identities: [githubIdentity(user)],
      headline: user.bio ? sanitizePlainText(user.bio, 500) : undefined,
      biography: user.bio ? sanitizePlainText(user.bio, 2_000) : undefined,
      location: user.location ? sanitizePlainText(user.location, 300) : undefined,
      affiliations: user.company ? [sanitizePlainText(user.company, 300)] : undefined,
      avatarUrl: user.avatar_url,
      websiteUrl: user.blog || undefined,
      sourceUrl: user.html_url,
    };

    const profileEvent = createDiscoveryEvent({
      source: "github",
      sourceExternalId: `user:${user.id}:${user.updated_at ?? user.created_at ?? "profile"}`,
      type: "profile_observed",
      title: `${person.displayName}'s open-source profile`,
      description: person.biography,
      occurredAt: user.updated_at ?? user.created_at,
      sourceUrl: user.html_url,
      person,
      metrics: {
        followers: asNumber(user.followers),
        following: asNumber(user.following),
        publicRepositories: asNumber(user.public_repos),
      },
      confidence: 0.98,
      now: context.now,
    });

    const hardConstraintKeywords = Array.isArray(context.settings.options?.complexityKeywords)
      ? context.settings.options.complexityKeywords
          .filter((item): item is string => typeof item === "string")
          .slice(0, 30)
      : [];
    const analyses = await Promise.all(
      repos.slice(0, 4).map(async (repo) => {
        try {
          return await analyzeGitHubRepositoryComplexity({
            owner: repo.owner.login,
            repo: repo.name,
            defaultBranch: repo.default_branch || "HEAD",
            stars: repo.stargazers_count,
            forks: repo.forks_count,
            description: repo.description,
            hardConstraintKeywords,
            headers: githubHeaders(),
            signal: context.signal,
          });
        } catch {
          return undefined;
        }
      }),
    );
    return {
      events: [
        profileEvent,
        ...repos.map((repo, index) => repositoryEvent(repo, context.now, analyses[index])),
      ],
    };
  }

  async expandGraph(context: ConnectorEnrichmentContext): Promise<GraphEdge[]> {
    const identity = context.person.identities.find(
      (item) => item.provider === "github" && item.username,
    );
    if (!identity?.username) return [];
    const maxItems = Math.min(50, context.settings.maxItems ?? 25);
    const following = await fetchJson<GitHubOwner[]>(
      `https://api.github.com/users/${encodeURIComponent(identity.username)}/following?per_page=${maxItems}`,
      {
        headers: githubHeaders(),
        rateLimitPerSecond: process.env.GITHUB_TOKEN ? 4 : 0.5,
        signal: context.signal,
      },
    );
    return following.map((target) => ({
      source: identity,
      target: ownerObservation(target),
      relation: "follows",
      weight: 0.35,
      sourceUrl: `https://github.com/${encodeURIComponent(identity.username!) }?tab=following`,
      observedAt: context.now.toISOString(),
    }));
  }
}
