import { fetchJson } from "../http";
import { sanitizePlainText } from "../security";
import { discoverCrossProfileIdentitiesFromHtml } from "../cross-profile-links";
import type {
  ConnectorEnrichmentContext,
  ConnectorRunContext,
  ConnectorRunResult,
  DiscoveryConnector,
  ExternalIdentity,
  GraphEdge,
  PersonObservation,
} from "../types";
import { asNumber, createDiscoveryEvent, mapLimit } from "./shared";

type HackerNewsItem = {
  id: number;
  by?: string;
  title?: string;
  text?: string;
  type?: string;
  time?: number;
  url?: string;
  score?: number;
  descendants?: number;
  deleted?: boolean;
  dead?: boolean;
  kids?: number[];
  parent?: number;
};

type HackerNewsUser = {
  id: string;
  about?: string;
  created?: number;
  karma?: number;
  submitted?: number[];
};

function personForHandle(
  handle: string,
  linkedIdentities: ExternalIdentity[] = [],
): PersonObservation {
  return {
    displayName: sanitizePlainText(handle, 200),
    identities: [
      {
        provider: "hacker-news",
        externalId: handle.toLowerCase(),
        username: handle,
        profileUrl: `https://news.ycombinator.com/user?id=${encodeURIComponent(handle)}`,
        verified: true,
      },
      ...linkedIdentities,
    ],
    sourceUrl: `https://news.ycombinator.com/user?id=${encodeURIComponent(handle)}`,
  };
}

export function isSelfAttributedShowHn(item: Pick<HackerNewsItem, "title" | "text">) {
  if (!item.title?.startsWith("Show HN:")) return false;
  const text = sanitizePlainText(
    (item.text ?? "")
      .replace(/&#x27;|&#39;|&apos;/gi, "'")
      .replace(/&quot;/gi, '"')
      .replace(/<[^>]+>/g, " "),
    2_000,
  );
  return /\b(?:i|we)(?:'ve| have|'m| am)?\s+(?:built|made|created|developed|launched|wrote|designed|open[- ]sourced|released|benchmarked|started|authored|working on)\b/i.test(text) ||
    /\b(?:i(?:'m| am))\s+(?:the\s+)?(?:author|creator|founder|developer|builder)\b/i.test(text);
}

function itemEvent(item: HackerNewsItem, now: Date, matchedTopics: string[] = []) {
  if (!item.by || !item.title) return null;
  const discussionUrl = `https://news.ycombinator.com/item?id=${item.id}`;
  const selfAttributedProject = isSelfAttributedShowHn(item);
  return createDiscoveryEvent({
    source: "hacker-news",
    sourceExternalId: String(item.id),
    type: selfAttributedProject ? "project_momentum" : "community_recognition",
    title: `${item.by} ${selfAttributedProject ? "introduced" : "shared"} “${sanitizePlainText(item.title, 400)}”`,
    description: item.text ? sanitizePlainText(item.text.replace(/<[^>]+>/g, " "), 2_000) : undefined,
    occurredAt: item.time ? new Date(item.time * 1_000).toISOString() : undefined,
    sourceUrl: item.url || discussionUrl,
    person: personForHandle(item.by),
    metrics: {
      points: asNumber(item.score),
      comments: asNumber(item.descendants),
      momentum: asNumber(item.score) + asNumber(item.descendants) * 1.5,
    },
    tags: [
      selfAttributedProject ? "self-attributed-builder" : "shared-link",
      ...matchedTopics.map((topic) => `topic:${topic}`),
    ],
    // A submission proves who posted a link, not who made the linked work.
    // Only a first-person Show HN description is strong enough for an
    // operator brief; ordinary sharing remains useful for graph discovery.
    confidence: selfAttributedProject ? 0.88 : 0.55,
    now,
  });
}

function matchedTopicKeywords(item: HackerNewsItem, keywords: string[]) {
  if (!keywords.length) return [];
  const corpus = `${item.title ?? ""}\n${item.text ?? ""}\n${item.url ?? ""}`.toLocaleLowerCase("en-US");
  return keywords.filter((keyword) => corpus.includes(keyword));
}

export class HackerNewsConnector implements DiscoveryConnector {
  readonly kind = "hacker-news" as const;
  readonly displayName = "Hacker News";

  async discover(context: ConnectorRunContext): Promise<ConnectorRunResult> {
    const maxItems = Math.min(100, context.settings.maxItems ?? 40);
    const feed = String(context.settings.options?.feed ?? "newstories");
    const validFeed = ["newstories", "beststories", "topstories", "showstories"].includes(feed)
      ? feed
      : "newstories";
    const ids = await fetchJson<number[]>(
      `https://hacker-news.firebaseio.com/v0/${validFeed}.json`,
      { signal: context.signal, rateLimitPerSecond: 8 },
    );
    const items = await mapLimit(ids.slice(0, maxItems * 2), 8, async (id) =>
      fetchJson<HackerNewsItem>(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, {
        signal: context.signal,
        rateLimitPerSecond: 8,
      }).catch(() => null),
    );
    const configuredMinimumScore = Number(context.settings.options?.minimumScore ?? 2);
    const minimumScore = Number.isFinite(configuredMinimumScore)
      ? Math.min(10_000, Math.max(0, configuredMinimumScore))
      : 2;
    const topicKeywords = Array.isArray(context.settings.options?.topicKeywords)
      ? context.settings.options.topicKeywords
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim().toLocaleLowerCase("en-US"))
          .filter(Boolean)
          .slice(0, 40)
      : [];
    const requireTopicMatch = context.settings.options?.requireTopicMatch === true;
    const rankedItems = items
      .filter(
        (item): item is HackerNewsItem =>
          Boolean(item && !item.deleted && !item.dead && item.type === "story" && asNumber(item.score) >= minimumScore),
      )
      .map((item, index) => ({
        item,
        index,
        matchedTopics: matchedTopicKeywords(item, topicKeywords),
      }))
      .filter((item) => !requireTopicMatch || item.matchedTopics.length > 0)
      // Topic matches are a precision aid, not a hard popularity proxy. Keep
      // the provider's feed order as the tie-breaker so novel work can surface.
      .sort(
        (left, right) =>
          right.matchedTopics.length - left.matchedTopics.length || left.index - right.index,
      );
    const events = rankedItems
      .map(({ item, matchedTopics }) => itemEvent(item, context.now, matchedTopics))
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
    return {
      events: events.slice(0, maxItems),
      cursor: { latestItemId: ids[0] ?? null },
    };
  }

  async enrich(context: ConnectorEnrichmentContext): Promise<ConnectorRunResult | null> {
    const identity = context.person.identities.find(
      (item) => item.provider === "hacker-news" && item.verified === true && item.username,
    );
    if (!identity?.username) return null;
    const handle = encodeURIComponent(identity.username);
    const user = await fetchJson<HackerNewsUser>(
      `https://hacker-news.firebaseio.com/v0/user/${handle}.json`,
      { signal: context.signal, rateLimitPerSecond: 8 },
    );
    const ids = user.submitted?.slice(0, 30) ?? [];
    const items = await mapLimit(ids, 8, async (id) =>
      fetchJson<HackerNewsItem>(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, {
        signal: context.signal,
        rateLimitPerSecond: 8,
      }).catch(() => null),
    );
    const linkedIdentities = user.about
      ? await discoverCrossProfileIdentitiesFromHtml({
          html: user.about,
          pageUrl: `https://news.ycombinator.com/user?id=${encodeURIComponent(user.id)}`,
          sourceOwned: true,
          signal: context.signal,
        })
      : [];
    // A matching handle across an HN user's own profile and a provider-verified
    // account is a strong association. Different handles remain hypotheses
    // unless the author explicitly marked the link rel=me.
    const classifiedLinkedIdentities = linkedIdentities.map((item) => ({
      ...item,
      verified:
        item.verified === true ||
        Boolean(item.username && item.username.toLowerCase() === user.id.toLowerCase()),
    }));
    const person: PersonObservation = {
      ...personForHandle(user.id, classifiedLinkedIdentities),
      biography: user.about
        ? sanitizePlainText(user.about.replace(/<[^>]+>/g, " "), 2_000)
        : undefined,
    };
    const profile = createDiscoveryEvent({
      source: "hacker-news",
      sourceExternalId: `user:${user.id}:${user.karma ?? 0}`,
      type: "profile_observed",
      title: `${user.id}'s Hacker News profile`,
      description: person.biography,
      occurredAt: user.created ? new Date(user.created * 1_000).toISOString() : undefined,
      sourceUrl: person.sourceUrl,
      person,
      metrics: { karma: asNumber(user.karma), submissions: user.submitted?.length ?? 0 },
      confidence: 0.98,
      now: context.now,
    });
    const stories = items
      .filter((item): item is HackerNewsItem => Boolean(item?.type === "story" && !item.deleted && !item.dead))
      .map((item) => itemEvent(item, context.now))
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
    return { events: [profile, ...stories] };
  }

  async expandGraph(context: ConnectorEnrichmentContext): Promise<GraphEdge[]> {
    const source = context.person.identities.find(
      (item) => item.provider === "hacker-news" && item.username && item.verified,
    );
    if (!source?.username) return [];
    const handle = encodeURIComponent(source.username);
    const user = await fetchJson<HackerNewsUser>(
      `https://hacker-news.firebaseio.com/v0/user/${handle}.json`,
      { signal: context.signal, rateLimitPerSecond: 8 },
    );
    const authoredItems = await mapLimit((user.submitted ?? []).slice(0, 20), 8, async (id) =>
      fetchJson<HackerNewsItem>(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, {
        signal: context.signal,
        rateLimitPerSecond: 8,
      }).catch(() => null),
    );
    const discussions = authoredItems
      .filter(
        (item): item is HackerNewsItem =>
          Boolean(item && !item.deleted && !item.dead && item.by === user.id && item.kids?.length),
      )
      .slice(0, 10);
    const interactions = await mapLimit(discussions, 5, async (discussion) => {
      const replies = await mapLimit((discussion.kids ?? []).slice(0, 12), 8, async (id) =>
        fetchJson<HackerNewsItem>(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, {
          signal: context.signal,
          rateLimitPerSecond: 8,
        }).catch(() => null),
      );
      return replies
        .filter(
          (reply): reply is HackerNewsItem =>
            Boolean(
              reply &&
              !reply.deleted &&
              !reply.dead &&
              reply.by &&
              reply.by !== user.id,
            ),
        )
        .map((reply): GraphEdge => ({
          source,
          target: personForHandle(reply.by!),
          relation: "engages_with",
          // A single reply is deliberately weak. Only repeated substantive
          // interaction or corroboration from another seed can create a candidate.
          weight: (reply.text?.length ?? 0) >= 180 ? 0.22 : 0.16,
          sourceUrl: `https://news.ycombinator.com/item?id=${reply.id}`,
          observedAt: context.now.toISOString(),
        }));
    });
    return interactions
      .flat()
      .sort(
        (left, right) =>
          right.weight - left.weight ||
          left.target.displayName.localeCompare(right.target.displayName) ||
          left.sourceUrl.localeCompare(right.sourceUrl),
      )
      .slice(0, Math.min(60, context.settings.maxItems ?? 35));
  }
}
