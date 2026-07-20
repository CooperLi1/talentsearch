import { fetchJson } from "../http";
import { sanitizePlainText } from "../security";
import type {
  ConnectorEnrichmentContext,
  ConnectorRunContext,
  ConnectorRunResult,
  DiscoveryConnector,
  PersonObservation,
} from "../types";
import { asNumber, createDiscoveryEvent } from "./shared";

type CodeforcesEnvelope<T> = { status: "OK" | "FAILED"; result?: T; comment?: string };
type Contest = {
  id: number;
  name: string;
  type: string;
  phase: string;
  startTimeSeconds?: number;
  durationSeconds?: number;
};
type StandingRow = {
  rank: number;
  points: number;
  penalty: number;
  party: { participantType: string; members: Array<{ handle: string }> };
};
type UserInfo = {
  handle: string;
  firstName?: string;
  lastName?: string;
  country?: string;
  city?: string;
  organization?: string;
  titlePhoto?: string;
  rating?: number;
  maxRating?: number;
  rank?: string;
  contribution?: number;
  friendOfCount?: number;
};
type RatingChange = {
  contestId: number;
  contestName: string;
  rank: number;
  ratingUpdateTimeSeconds: number;
  oldRating: number;
  newRating: number;
};

async function codeforces<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetchJson<CodeforcesEnvelope<T>>(
    `https://codeforces.com/api/${path}`,
    { signal, rateLimitPerSecond: 0.4, timeoutMs: 18_000 },
  );
  if (response.status !== "OK" || response.result === undefined) {
    throw new Error(response.comment || "Codeforces API request failed");
  }
  return response.result;
}

function userPerson(user: UserInfo): PersonObservation {
  const name = sanitizePlainText(
    [user.firstName, user.lastName].filter(Boolean).join(" ") || user.handle,
    200,
  );
  return {
    displayName: name,
    identities: [
      {
        provider: "codeforces",
        externalId: user.handle.toLowerCase(),
        username: user.handle,
        profileUrl: `https://codeforces.com/profile/${encodeURIComponent(user.handle)}`,
        verified: true,
      },
    ],
    headline: user.rank ? `${user.rank} competitive programmer` : "Competitive programmer",
    location: [user.city, user.country].filter(Boolean).join(", ") || undefined,
    affiliations: user.organization ? [sanitizePlainText(user.organization, 300)] : undefined,
    avatarUrl: user.titlePhoto,
    sourceUrl: `https://codeforces.com/profile/${encodeURIComponent(user.handle)}`,
  };
}

export class CodeforcesConnector implements DiscoveryConnector {
  readonly kind = "codeforces" as const;
  readonly displayName = "Codeforces";

  async discover(context: ConnectorRunContext): Promise<ConnectorRunResult> {
    const maxItems = Math.min(100, context.settings.maxItems ?? 30);
    const maxContests = Math.min(5, Number(context.settings.options?.maxContests ?? 2));
    const contests = await codeforces<Contest[]>("contest.list?gym=false", context.signal);
    const recent = contests
      .filter((contest) => contest.phase === "FINISHED" && contest.startTimeSeconds)
      .sort((a, b) => (b.startTimeSeconds ?? 0) - (a.startTimeSeconds ?? 0))
      .slice(0, maxContests);
    const events = [];
    const warnings: string[] = [];
    for (const contest of recent) {
      try {
        const result = await codeforces<{ contest: Contest; rows: StandingRow[] }>(
          `contest.standings?contestId=${contest.id}&from=1&count=${Math.ceil(maxItems / recent.length)}&showUnofficial=false`,
          context.signal,
        );
        for (const row of result.rows) {
          for (const member of row.party.members) {
            const person = userPerson({ handle: member.handle });
            events.push(
              createDiscoveryEvent({
                source: "codeforces",
                sourceExternalId: `${contest.id}:${member.handle.toLowerCase()}`,
                type: "competition_result",
                title: `${member.handle} placed #${row.rank} in ${contest.name}`,
                description: `${row.points} points with ${row.penalty} penalty.`,
                occurredAt: contest.startTimeSeconds
                  ? new Date(contest.startTimeSeconds * 1_000).toISOString()
                  : undefined,
                sourceUrl: `https://codeforces.com/contest/${contest.id}/standings`,
                person,
                metrics: { rank: row.rank, points: row.points, fieldSignal: 1 / Math.max(1, row.rank) },
                tags: [contest.type, "competitive-programming"],
                confidence: 0.98,
                now: context.now,
              }),
            );
          }
        }
      } catch (error) {
        warnings.push(
          `${contest.name}: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }
    }
    return {
      events: events.slice(0, maxItems),
      cursor: { latestContestId: recent[0]?.id ?? null },
      warnings,
    };
  }

  async enrich(context: ConnectorEnrichmentContext): Promise<ConnectorRunResult | null> {
    const identity = context.person.identities.find(
      (item) => item.provider === "codeforces" && item.verified === true && item.username,
    );
    if (!identity?.username) return null;
    const handle = encodeURIComponent(identity.username);
    const [users, changes] = await Promise.all([
      codeforces<UserInfo[]>(`user.info?handles=${handle}&checkHistoricHandles=true`, context.signal),
      codeforces<RatingChange[]>(`user.rating?handle=${handle}`, context.signal),
    ]);
    const user = users[0];
    if (!user) return null;
    const person = userPerson(user);
    const profileEvent = createDiscoveryEvent({
      source: "codeforces",
      sourceExternalId: `profile:${user.handle.toLowerCase()}:${user.rating ?? 0}`,
      type: "profile_observed",
      title: `${person.displayName}'s competitive programming profile`,
      description: user.rank ? `Current rank: ${user.rank}.` : undefined,
      sourceUrl: person.sourceUrl,
      person,
      metrics: {
        rating: asNumber(user.rating),
        maxRating: asNumber(user.maxRating),
        contribution: asNumber(user.contribution),
        followers: asNumber(user.friendOfCount),
      },
      confidence: 0.99,
      now: context.now,
    });
    const history = changes.slice(-12).map((change) =>
      createDiscoveryEvent({
        source: "codeforces",
        sourceExternalId: `${change.contestId}:${user.handle.toLowerCase()}`,
        type: "competition_result",
        title: `${person.displayName} placed #${change.rank} in ${change.contestName}`,
        occurredAt: new Date(change.ratingUpdateTimeSeconds * 1_000).toISOString(),
        sourceUrl: `https://codeforces.com/contest/${change.contestId}/standings`,
        person,
        metrics: {
          rank: change.rank,
          oldRating: change.oldRating,
          newRating: change.newRating,
          ratingDelta: change.newRating - change.oldRating,
        },
        tags: ["competitive-programming"],
        confidence: 0.99,
        now: context.now,
      }),
    );
    return { events: [profileEvent, ...history] };
  }
}
