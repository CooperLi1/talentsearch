import { fetchJson } from "../http";
import { sanitizePlainText } from "../security";
import type {
  ConnectorEnrichmentContext,
  ConnectorRunContext,
  ConnectorRunResult,
  DiscoveryConnector,
  GraphEdge,
  PersonObservation,
} from "../types";
import { asNumber, createDiscoveryEvent } from "./shared";

type XUser = {
  id: string;
  name: string;
  username: string;
  description?: string;
  location?: string;
  profile_image_url?: string;
  url?: string;
  verified?: boolean;
  public_metrics?: {
    followers_count?: number;
    following_count?: number;
    tweet_count?: number;
    listed_count?: number;
  };
};

type XPost = {
  id: string;
  author_id?: string;
  created_at?: string;
  text?: string;
  public_metrics?: {
    retweet_count?: number;
    reply_count?: number;
    like_count?: number;
    quote_count?: number;
    bookmark_count?: number;
    impression_count?: number;
  };
};

type XResponse = {
  data?: XPost[] | XUser[] | XUser;
  includes?: { users?: XUser[] };
  meta?: { next_token?: string };
};

function headers(): HeadersInit {
  const token = process.env.X_BEARER_TOKEN;
  if (!token) throw new Error("X_BEARER_TOKEN is not configured; X connector remains disabled");
  return { authorization: `Bearer ${token}` };
}

function userPerson(user: XUser): PersonObservation {
  return {
    displayName: sanitizePlainText(user.name || user.username, 200),
    identities: [
      {
        provider: "x",
        externalId: user.id,
        username: user.username,
        profileUrl: `https://x.com/${encodeURIComponent(user.username)}`,
        verified: true,
      },
    ],
    headline: user.description ? sanitizePlainText(user.description, 500) : undefined,
    biography: user.description ? sanitizePlainText(user.description, 2_000) : undefined,
    location: user.location ? sanitizePlainText(user.location, 300) : undefined,
    avatarUrl: user.profile_image_url,
    websiteUrl: user.url,
    sourceUrl: `https://x.com/${encodeURIComponent(user.username)}`,
  };
}

function postEvent(post: XPost, user: XUser, now: Date) {
  const postUrl = `https://x.com/${encodeURIComponent(user.username)}/status/${post.id}`;
  const metrics = post.public_metrics ?? {};
  return createDiscoveryEvent({
    source: "x",
    sourceExternalId: post.id,
    type: "social_graph_signal",
    title: `${user.name} shared a new signal`,
    description: post.text,
    occurredAt: post.created_at,
    sourceUrl: postUrl,
    person: userPerson(user),
    metrics: {
      likes: asNumber(metrics.like_count),
      reposts: asNumber(metrics.retweet_count),
      replies: asNumber(metrics.reply_count),
      quotes: asNumber(metrics.quote_count),
      impressions: asNumber(metrics.impression_count),
      momentum:
        asNumber(metrics.like_count) +
        asNumber(metrics.retweet_count) * 2 +
        asNumber(metrics.reply_count) * 1.5,
    },
    confidence: 0.9,
    now,
  });
}

export class XConnector implements DiscoveryConnector {
  readonly kind = "x" as const;
  readonly displayName = "X official API";

  async discover(context: ConnectorRunContext): Promise<ConnectorRunResult> {
    if (!process.env.X_BEARER_TOKEN) {
      return { events: [], warnings: ["X disabled: official API bearer token is not configured"] };
    }
    const maxItems = Math.min(100, Math.max(10, context.settings.maxItems ?? 30));
    const queries = context.settings.queries?.filter(Boolean) ?? [];
    if (!queries.length) return { events: [], warnings: ["X enabled but no search queries are configured"] };
    const events = [];
    const warnings: string[] = [];
    for (const query of queries.slice(0, 5)) {
      const url = new URL("https://api.x.com/2/tweets/search/recent");
      url.searchParams.set("query", `${query} -is:retweet`);
      url.searchParams.set("max_results", String(Math.max(10, Math.ceil(maxItems / queries.length))));
      url.searchParams.set("tweet.fields", "author_id,created_at,public_metrics");
      url.searchParams.set(
        "user.fields",
        "description,location,name,profile_image_url,public_metrics,url,username,verified",
      );
      url.searchParams.set("expansions", "author_id");
      try {
        const response = await fetchJson<XResponse>(url.toString(), {
          headers: headers(),
          signal: context.signal,
          rateLimitPerSecond: 0.5,
        });
        const users = new Map((response.includes?.users ?? []).map((user) => [user.id, user]));
        for (const post of (response.data as XPost[] | undefined) ?? []) {
          const user = post.author_id ? users.get(post.author_id) : undefined;
          if (user) events.push(postEvent(post, user, context.now));
        }
      } catch (error) {
        warnings.push(
          `X query failed: ${error instanceof Error ? error.message : "unknown error"}`,
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
    if (!process.env.X_BEARER_TOKEN) return null;
    const identity = context.person.identities.find(
      (item) => item.provider === "x" && (item.username || item.externalId),
    );
    if (!identity) return null;
    const userUrl = identity.username
      ? `https://api.x.com/2/users/by/username/${encodeURIComponent(identity.username)}`
      : `https://api.x.com/2/users/${encodeURIComponent(identity.externalId)}`;
    const userResponse = await fetchJson<{ data?: XUser }>(
      `${userUrl}?user.fields=description,location,name,profile_image_url,public_metrics,url,username,verified`,
      { headers: headers(), signal: context.signal, rateLimitPerSecond: 0.5 },
    );
    const user = userResponse.data;
    if (!user) return null;
    const posts = await fetchJson<{ data?: XPost[] }>(
      `https://api.x.com/2/users/${user.id}/tweets?max_results=20&exclude=retweets,replies&tweet.fields=author_id,created_at,public_metrics`,
      { headers: headers(), signal: context.signal, rateLimitPerSecond: 0.5 },
    );
    const profile = createDiscoveryEvent({
      source: "x",
      sourceExternalId: `user:${user.id}:${user.public_metrics?.tweet_count ?? 0}`,
      type: "profile_observed",
      title: `${user.name}'s public X profile`,
      description: user.description,
      sourceUrl: `https://x.com/${encodeURIComponent(user.username)}`,
      person: userPerson(user),
      metrics: {
        followers: asNumber(user.public_metrics?.followers_count),
        following: asNumber(user.public_metrics?.following_count),
        posts: asNumber(user.public_metrics?.tweet_count),
        listed: asNumber(user.public_metrics?.listed_count),
      },
      confidence: 0.98,
      now: context.now,
    });
    return { events: [profile, ...(posts.data ?? []).map((post) => postEvent(post, user, context.now))] };
  }

  async expandGraph(context: ConnectorEnrichmentContext): Promise<GraphEdge[]> {
    if (!process.env.X_BEARER_TOKEN) return [];
    const source = context.person.identities.find((item) => item.provider === "x");
    if (!source) return [];
    const maxItems = Math.min(100, context.settings.maxItems ?? 25);
    const response = await fetchJson<{ data?: XUser[] }>(
      `https://api.x.com/2/users/${encodeURIComponent(source.externalId)}/following?max_results=${Math.max(1_000, maxItems)}&user.fields=description,location,name,profile_image_url,public_metrics,url,username,verified`,
      { headers: headers(), signal: context.signal, rateLimitPerSecond: 0.25 },
    );
    return (response.data ?? []).slice(0, maxItems).map((user) => ({
      source,
      target: userPerson(user),
      relation: "follows",
      weight: 0.4,
      sourceUrl: `https://x.com/${encodeURIComponent(source.username ?? source.externalId)}/following`,
      observedAt: context.now.toISOString(),
    }));
  }
}
