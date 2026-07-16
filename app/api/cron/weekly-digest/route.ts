import {
  claimDigestDelivery,
  createDigest,
  getActiveCriterionProfile,
  getCandidateBySlug,
  getOldestReadyDigest,
  listDigestCandidateSnapshots,
  listDigestSubscribers,
  rankCandidatesForDigest,
  updateDigestDelivery,
  updateSubscriberDeliveries,
} from "@/lib/data/talent-radar";
import type { DigestRecord } from "@/lib/data/contracts";
import {
  buildOperatorBrief,
  hasGroundedOperatorBrief,
  hasIndependentEvidenceCoverage,
  hasIndependentOperatorBriefCoverage,
} from "@/lib/candidates/operator-brief";
import { digestScheduleWindow } from "@/lib/digest/schedule";
import { digestCandidateSnapshotCopy } from "@/lib/digest/candidate-snapshot";
import { sendWeeklyDigest } from "@/lib/email/send-weekly-digest";
import type { DigestCandidate } from "@/lib/email/types";
import type { Json } from "@/lib/supabase/database.types";

import { apiErrorResponse, assertCronRequest, getWorkspaceId } from "../../_lib/http";

export const runtime = "nodejs";
export const maxDuration = 300;

const DIGEST_CLAIM_STALE_MINUTES = 15;
const DIGEST_RETRY_WINDOW_MINUTES = 23 * 60;
const DIGEST_RETRY_WINDOW_MILLISECONDS = DIGEST_RETRY_WINDOW_MINUTES * 60 * 1_000;
const VERCEL_HOBBY_DISPATCH_WINDOW_MINUTES = 120;

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
  const requiredStrings = ["id", "name", "headline", "summary"] as const;
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
  const candidate = value as unknown as Omit<DigestCandidate, "facts"> & { facts?: DigestCandidate["facts"] };
  const facts = Array.isArray(value.facts)
    ? value.facts.flatMap((fact) => {
        if (!isJsonRecord(fact) || typeof fact.text !== "string" || !Array.isArray(fact.sources)) return [];
        const sources = fact.sources.flatMap((source) =>
          isJsonRecord(source) && typeof source.label === "string" && typeof source.url === "string"
            ? [{ label: source.label, url: source.url }]
            : [],
        );
        return [{ text: fact.text, sources }];
      })
    : [];
  return {
    ...candidate,
    facts: facts.length
      ? facts
      : [candidate.headline, candidate.summary]
          .filter((text, index, values) => text.trim() && values.indexOf(text) === index)
          .slice(0, 5)
          .map((text) => ({ text, sources: [] })),
  };
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

async function deliverDigestRecord(digest: DigestRecord, workspaceId: string) {
  let claimedDigest: DigestRecord | null = null;
  let deliveryFinalized = false;
  try {
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

    const subscribers = await listDigestSubscribers(workspaceId);
    const activeSubscribers = subscribers.filter((subscriber) => subscriber.status === "active");
    const delivery = await sendWeeklyDigest({
      digestId: claimedDigest.id,
      idempotencyKey: claimedDigest.dedupeKey,
      periodStart: claimedDigest.periodStart,
      periodEnd: claimedDigest.periodEnd,
      subject: claimedDigest.subject,
      recipients: activeSubscribers.map((subscriber) => ({
        email: subscriber.email,
        name: subscriber.displayName ?? undefined,
      })),
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
        activeSubscribers.map((subscriber) => ({
          subscriberId: subscriber.id,
          deliveryStatus: "delivered",
          lastSentAt: sentAt,
        })),
      );
    }
    console.info("[weekly-digest] delivery finalized", {
      digestId: claimedDigest.id,
      status: delivery.status,
      candidateCount: deliveryCandidates.length,
      recipientCount: delivery.recipientCount,
    });
    return Response.json({ ok: true, digestId: claimedDigest.id, delivery });
  } catch (error) {
    if (claimedDigest && !deliveryFinalized) {
      try {
        await updateDigestDelivery(claimedDigest.id, claimedDigest.workspaceId, {
          status: "failed",
          sentAt: null,
          deliveryMetadata: { status: "failed", reason: "unhandled-route-error" },
        });
      } catch (stateError) {
        console.error("Failed to release weekly digest claim", {
          digestId: claimedDigest.id,
          errorName: stateError instanceof Error ? stateError.name : "unknown",
        });
      }
    }
    throw error;
  }
}

export async function GET(request: Request) {
  try {
    assertCronRequest(request);
    const workspaceId = getWorkspaceId();
    const overdueDigest = await getOldestReadyDigest(workspaceId);
    if (overdueDigest) {
      console.info("[weekly-digest] reclaiming overdue prepared digest", {
        digestId: overdueDigest.id,
        scheduledFor: overdueDigest.scheduledFor,
      });
      return deliverDigestRecord(overdueDigest, workspaceId);
    }
    const criterion = await getActiveCriterionProfile(workspaceId);
    const schedule = digestScheduleWindow(
      new Date(),
      criterion?.digestDaysOfWeek ?? [1],
      criterion?.digestDeliveryHourUtc ?? 15,
      criterion?.digestDeliveryMinuteUtc ?? 0,
      criterion?.digestPreparationLeadHours ?? 3,
      request.headers.get("x-vercel-cron-schedule")
        ? VERCEL_HOBBY_DISPATCH_WINDOW_MINUTES
        : undefined,
    );
    if (!schedule.due || schedule.phase === "idle") {
      console.info("[weekly-digest] skipped", {
        checkedAt: new Date().toISOString(),
        deliveryHourUtc: schedule.deliveryHourUtc,
        deliveryMinuteUtc: schedule.deliveryMinuteUtc,
        daysOfWeek: schedule.daysOfWeek,
        reason: "not-scheduled",
      });
      return Response.json({ ok: true, skipped: true, reason: "not-scheduled" });
    }
    const { dedupeKey, periodStart, periodEnd } = schedule;
    const requestedCandidateCount = criterion?.weeklyCandidateCount ?? 12;
    const ranked = await rankCandidatesForDigest(workspaceId, {
      minimumScore: criterion?.minimumScore ?? 25,
      // Hydration applies the independent-publisher gate, so inspect the full
      // bounded ranking instead of assuming the first few rows will qualify.
      limit: 100,
    });
    const candidates = (await Promise.all(ranked.map((item) => getCandidateBySlug(item.slug, workspaceId))))
      .filter((candidate): candidate is NonNullable<typeof candidate> =>
        Boolean(candidate) && hasGroundedOperatorBrief(candidate as NonNullable<typeof candidate>),
      )
      .filter((candidate) => hasIndependentEvidenceCoverage(candidate))
      .filter((candidate) => hasIndependentOperatorBriefCoverage(candidate))
      .slice(0, requestedCandidateCount);
    const emailCandidates: DigestCandidate[] = candidates.map((candidate) => {
      const facts = buildOperatorBrief(candidate);
      const copy = digestCandidateSnapshotCopy({
        name: candidate.name,
        headline: candidate.headline,
        summary: candidate.summaryMarkdown,
        facts,
      });
      return {
        id: candidate.id,
        name: candidate.name,
        headline: copy.headline,
        summary: copy.summary,
        facts,
        confidence: candidate.confidenceBand,
        score: candidate.score,
        location: candidate.location || undefined,
        profileUrl: dossierUrl(candidate.slug),
        sources: facts
          .flatMap((fact) => fact.sources)
          .filter((source, index, sources) => sources.findIndex((item) => item.url === source.url) === index),
      };
    });
    const subject = `Unfound: ${emailCandidates.length} candidates to review`;
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
        whyNowMarkdown: "",
        evidenceLinks: candidates[index]?.latestEvent?.links ?? [],
        payloadSnapshot: JSON.parse(JSON.stringify(emailCandidate)) as Json,
      })),
    });
    const candidateSnapshots = await listDigestCandidateSnapshots(digest.id, workspaceId);
    if (candidateSnapshots.length !== digest.candidateCount) {
      throw new Error("Digest candidate snapshot is incomplete");
    }
    if (schedule.phase === "prepare") {
      console.info("[weekly-digest] prepared", {
        digestId: digest.id,
        candidateCount: digest.candidateCount,
        scheduledFor: periodEnd,
      });
      return Response.json({
        ok: true,
        prepared: true,
        digestId: digest.id,
        scheduledFor: periodEnd,
      });
    }
    return deliverDigestRecord(digest, workspaceId);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
