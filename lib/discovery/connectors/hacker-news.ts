import { fetchJson } from "../http";
import { sanitizePlainText } from "../security";
import type {
  ConnectorEnrichmentContext,
  ConnectorRunContext,
  ConnectorRunResult,
  DiscoveryConnector,
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
};

type HackerNewsUser = {
  id: string;
  about?: string;
  created?: number;
  karma?: number;
  submitted?: number[];
};

function personForHandle(handle: string): PersonObservation {
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
    ],
    sourceUrl: `https://news.ycombinator.com/user?id=${encodeURIComponent(handle)}`,
  };
}

function itemEvent(item: HackerNewsItem, now: Date) {
  if (!item.by || !item.title) return null;
  const discussionUrl = `https://news.ycombinator.com/item?id=${item.id}`;
  return createDiscoveryEvent({
    source: "hacker-news",
    sourceExternalId: String(item.id),
    type: item.title.startsWith("Show HN:") ? "project_momentum" : "community_recognition",
    title: `${item.by} shared “${sanitizePlainText(item.title, 400)}”`,
    description: item.text ? sanitizePlainText(item.text.replace(/<[^>]+>/g, " "), 2_000) : undefined,
    occurredAt: item.time ? new Date(item.time * 1_000).toISOString() : undefined,
    sourceUrl: item.url || discussionUrl,
    person: personForHandle(item.by),
    metrics: {
      points: asNumber(item.score),
      comments: asNumber(item.descendants),
      momentum: asNumber(item.score) + asNumber(item.descendants) * 1.5,
    },
    tags: [item.title.startsWith("Show HN:") ? "builder" : "community"],
    confidence: 0.85,
    now,
  });
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
    const minimumScore = Number(context.settings.options?.minimumScore ?? 2);
    const events = items
      .filter(
        (item): item is HackerNewsItem =>
          Boolean(item && !item.deleted && !item.dead && item.type === "story" && asNumber(item.score) >= minimumScore),
      )
      .map((item) => itemEvent(item, context.now))
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
    return {
      events: events.slice(0, maxItems),
      cursor: { latestItemId: ids[0] ?? null },
    };
  }

  async enrich(context: ConnectorEnrichmentContext): Promise<ConnectorRunResult | null> {
    const identity = context.person.identities.find(
      (item) => item.provider === "hacker-news" && item.username,
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
    const person: PersonObservation = {
      ...personForHandle(user.id),
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
}
