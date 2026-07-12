import {
  claimDigestDelivery,
  createDigest,
  getActiveCriterionProfile,
  getCandidateBySlug,
  listDigestCandidateSnapshots,
  listDigestSubscribers,
  rankCandidatesForDigest,
  updateDigestDelivery,
  updateSubscriberDeliveries,
} from "@/lib/data/talent-radar";
import type { DigestRecord } from "@/lib/data/contracts";
import { sendWeeklyDigest } from "@/lib/email/send-weekly-digest";
import type { DigestCandidate } from "@/lib/email/types";
import type { Json } from "@/lib/supabase/database.types";

import { apiErrorResponse, assertCronRequest, getWorkspaceId } from "../../_lib/http";

export const runtime = "nodejs";
export const maxDuration = 300;

const WEEK_MILLISECONDS = 7 * 24 * 60 * 60 * 1_000;
const DIGEST_CLAIM_STALE_MINUTES = 15;
const DIGEST_RETRY_WINDOW_MINUTES = 23 * 60;
const DIGEST_RETRY_WINDOW_MILLISECONDS = DIGEST_RETRY_WINDOW_MINUTES * 60 * 1_000;

function weeklyDigestWindow(now: Date) {
  const daysSinceMonday = (now.getUTCDay() + 6) % 7;
  let anchorMilliseconds = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - daysSinceMonday,
    15,
  );
  if (anchorMilliseconds > now.getTime()) anchorMilliseconds -= WEEK_MILLISECONDS;

  const periodEnd = new Date(anchorMilliseconds).toISOString();
  return {
    dedupeKey: `weekly:${periodEnd}`,
    periodStart: new Date(anchorMilliseconds - WEEK_MILLISECONDS).toISOString(),
    periodEnd,
  };
}

function skipReason(digest: DigestRecord) {
  if (digest.status === "sent") return "already-sent";
  if (digest.status === "failed") return "retry-window-expired";
  if (digest.status === "sending") {
    const updatedAt = Date.parse(digest.updatedAt);
    if (Number.isFinite(updatedAt) && Date.now() - updatedAt > DIGEST_RETRY_WINDOW_MILLISECONDS) {
      return "retry-window-expired";
    }
    return "in-flight";
  }
  return "not-deliverable";
}

function isJsonRecord(value: Json): value is { [key: string]: Json | undefined } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseDigestCandidateSnapshot(value: Json): DigestCandidate {
  if (!isJsonRecord(value)) throw new Error("Digest candidate snapshot is invalid");
  const requiredStrings = ["id", "name", "headline", "summary", "whyNow", "earlyness"] as const;
  if (requiredStrings.some((key) => typeof value[key] !== "string")) {
    throw new Error("Digest candidate snapshot is incomplete");
  }
  if (value.confidence !== "high" && value.confidence !== "medium" && value.confidence !== "low") {
    throw new Error("Digest candidate snapshot confidence is invalid");
  }
  if (!Array.isArray(value.sources) || value.sources.some((source) => (
    !isJsonRecord(source) || typeof source.label !== "string" || typeof source.url !== "string"
  ))) {
    throw new Error("Digest candidate snapshot sources are invalid");
  }
  return value as unknown as DigestCandidate;
}

function dossierUrl(slug: string) {
  const base = process.env.NEXT_PUBLIC_APP_URL;
  if (!base) return undefined;
  try {
    return new URL(`/people/${encodeURIComponent(slug)}`, base).toString();
  } catch {
    return undefined;
  }
}

export async function GET(request: Request) {
  let claimedDigest: DigestRecord | null = null;
  let deliveryFinalized = false;

  try {
    assertCronRequest(request);
    const workspaceId = getWorkspaceId();
    const { dedupeKey, periodStart, periodEnd } = weeklyDigestWindow(new Date());
    const criterion = await getActiveCriterionProfile(workspaceId);
    const [ranked, subscribers] = await Promise.all([
      rankCandidatesForDigest(workspaceId, {
        minimumScore: criterion?.minimumScore ?? 55,
        limit: criterion?.weeklyCandidateCount ?? 12,
      }),
      listDigestSubscribers(workspaceId),
    ]);
    const candidates = (await Promise.all(ranked.map((item) => getCandidateBySlug(item.slug, workspaceId))))
      .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));
    const emailCandidates: DigestCandidate[] = candidates.map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      headline: candidate.headline,
      summary: candidate.summaryMarkdown,
      whyNow: candidate.whyNowMarkdown,
      earlyness: candidate.earlynessMarkdown,
      confidence: candidate.confidenceBand,
      score: candidate.score,
      location: candidate.location || undefined,
      profileUrl: dossierUrl(candidate.slug),
      sources: (candidate.latestEvent?.links ?? []).map((link) => ({ label: link.label, url: link.url })),
      newEvent: candidate.latestEvent
        ? { title: candidate.latestEvent.title, summary: candidate.latestEvent.summaryMarkdown, occurredAt: candidate.latestEvent.occurredAt ?? undefined }
        : undefined,
    }));
    const subject = `Unfound: ${emailCandidates.length} new signals`;
    const { digest } = await createDigest({
      workspaceId,
      dedupeKey,
      criterionProfileId: criterion?.id === "unconfigured" ? null : criterion?.id,
      periodStart,
      periodEnd,
      subject,
      scheduledFor: periodEnd,
      items: emailCandidates.map((emailCandidate, index) => ({
        candidateId: emailCandidate.id,
        rank: index + 1,
        score: emailCandidate.score ?? 0,
        headline: emailCandidate.headline,
        summaryMarkdown: emailCandidate.summary,
        whyNowMarkdown: emailCandidate.whyNow,
        evidenceLinks: candidates[index]?.latestEvent?.links ?? [],
        payloadSnapshot: JSON.parse(JSON.stringify(emailCandidate)) as Json,
      })),
    });
    const candidateSnapshots = await listDigestCandidateSnapshots(digest.id, workspaceId);
    if (candidateSnapshots.length !== digest.candidateCount) {
      throw new Error("Digest candidate snapshot is incomplete");
    }
    const deliveryCandidates = candidateSnapshots.map(parseDigestCandidateSnapshot);
    const claim = await claimDigestDelivery(
      digest.id,
      workspaceId,
      DIGEST_CLAIM_STALE_MINUTES,
      DIGEST_RETRY_WINDOW_MINUTES,
    );
    if (!claim) throw new Error("Digest disappeared before delivery could be claimed");
    if (!claim.claimed) {
      return Response.json({
        ok: true,
        skipped: true,
        reason: skipReason(claim.digest),
        digestId: claim.digest.id,
        status: claim.digest.status,
      });
    }
    claimedDigest = claim.digest;

    const activeSubscribers = subscribers.filter((subscriber) => subscriber.status === "active");
    const delivery = await sendWeeklyDigest({
      digestId: claimedDigest.id,
      idempotencyKey: claimedDigest.dedupeKey,
      periodStart: claimedDigest.periodStart,
      periodEnd: claimedDigest.periodEnd,
      subject: claimedDigest.subject,
      recipients: activeSubscribers.map((subscriber) => ({ email: subscriber.email, name: subscriber.displayName ?? undefined })),
      candidates: deliveryCandidates,
      dashboardUrl: process.env.NEXT_PUBLIC_APP_URL,
    });
    const sentAt = delivery.status === "sent" ? new Date().toISOString() : null;
    const finalizedDigest = await updateDigestDelivery(claimedDigest.id, workspaceId, {
      status: delivery.status === "sent" ? "sent" : delivery.status === "failed" ? "failed" : "ready",
      recipientCount: delivery.recipientCount,
      sentAt,
      providerMessageId: delivery.status === "sent" ? delivery.batches[0]?.emailIds[0] ?? null : null,
      deliveryMetadata: JSON.parse(JSON.stringify(delivery)),
    });
    if (!finalizedDigest) throw new Error("Digest delivery state changed before completion");
    deliveryFinalized = true;

    if (sentAt) {
      await updateSubscriberDeliveries(
        workspaceId,
        activeSubscribers.map((subscriber) => ({ subscriberId: subscriber.id, deliveryStatus: "delivered", lastSentAt: sentAt })),
      );
    }
    return Response.json({ ok: true, digestId: claimedDigest.id, delivery });
  } catch (error) {
    if (claimedDigest && !deliveryFinalized) {
      try {
        await updateDigestDelivery(claimedDigest.id, claimedDigest.workspaceId, {
          status: "failed",
          sentAt: null,
          deliveryMetadata: {
            status: "failed",
            reason: "unhandled-route-error",
          },
        });
      } catch (stateError) {
        console.error("Failed to release weekly digest claim", {
          digestId: claimedDigest.id,
          errorName: stateError instanceof Error ? stateError.name : "unknown",
        });
      }
    }
    if (claimedDigest) {
      console.error("Weekly digest route failed", {
        digestId: claimedDigest.id,
        errorName: error instanceof Error ? error.name : "unknown",
      });
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
    return apiErrorResponse(error);
  }
}
