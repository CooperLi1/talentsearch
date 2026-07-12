import {
  createCriterionProfileVersion,
  getActiveCriterionProfile,
  getCandidateBySlug,
  listTasteFeedback,
  recordCandidateFeedback,
  updateCandidateIntelligence,
} from "@/lib/data/talent-radar";
import { updateTasteWeights, type TasteFeedback } from "@/lib/discovery/taste";
import type { CandidateStatus } from "@/lib/domain/types";
import type { CandidateFeatureVector } from "@/lib/discovery/types";

import { ApiError, getWorkspaceId, readJson, withDashboard } from "../_lib/http";
import { feedbackRequestSchema } from "../_lib/schemas";

const decisionMap = { shortlist: "save", watch: "watch", pass: "pass" } as const;
const outcomeMap: Record<string, TasteFeedback["outcome"] | undefined> = {
  save: "save", refer: "save", watch: "watch", pass: "pass", reject: "pass",
  contact: "contact", interview: "interview", accept: "accept",
};
const statusMap: Partial<Record<string, CandidateStatus>> = {
  accept: "fellow",
  contact: "contacted",
  interview: "interviewing",
  pass: "passed",
  refer: "saved",
  reject: "passed",
  save: "saved",
  watch: "watching",
};

function featureVector(value: Record<string, number>): CandidateFeatureVector | null {
  const keys: Array<keyof CandidateFeatureVector> = ["achievementQuality", "trajectoryVelocity", "projectOriginality", "technicalComplexity", "networkProximity", "evidenceDiversity", "earlyness"];
  if (!keys.some((key) => Number.isFinite(value[key]))) return null;
  return Object.fromEntries(keys.map((key) => [key, Number.isFinite(value[key]) ? value[key] : 0])) as CandidateFeatureVector;
}

export async function POST(request: Request) {
  return withDashboard(request, async () => {
    const input = await readJson(request, feedbackRequestSchema);
    const workspaceId = getWorkspaceId();
    const candidate = await getCandidateBySlug(input.candidateId, workspaceId);
    if (!candidate) throw new ApiError(404, "Candidate not found");
    const action = input.action ?? decisionMap[input.decision!];
    await recordCandidateFeedback({
      workspaceId,
      candidateId: candidate.id,
      action,
      reasonCode: input.reasonCode,
      note: input.note,
      actorKey: "dashboard",
      context: (input.context ?? {}) as never,
    });
    const status = statusMap[action];
    if (status) {
      await updateCandidateIntelligence({
        workspaceId,
        candidateId: candidate.id,
        status,
      });
    }

    const [profile, records] = await Promise.all([
      getActiveCriterionProfile(workspaceId),
      listTasteFeedback(workspaceId, 500),
    ]);
    let criterionUpdated = false;
    if (profile && records.length >= 8 && records.length % 4 === 0) {
      const feedback = records.flatMap((record) => {
        const outcome = outcomeMap[record.action];
        const features = featureVector(record.scoreComponents);
        return outcome && features ? [{ outcome, features }] : [];
      });
      if (feedback.length >= 8) {
        const current = Object.fromEntries(
          profile.signals.map((signal) => [signal.key, signal.weight]),
        ) as Partial<CandidateFeatureVector>;
        const learned = updateTasteWeights({
          current: { achievementQuality: current.achievementQuality ?? .25, trajectoryVelocity: current.trajectoryVelocity ?? .17,
            projectOriginality: current.projectOriginality ?? .14, technicalComplexity: current.technicalComplexity ?? .15,
            networkProximity: current.networkProximity ?? .12, evidenceDiversity: current.evidenceDiversity ?? .08, earlyness: current.earlyness ?? .09 },
          feedback,
          learningRate: profile.learningRate,
        });
        await createCriterionProfileVersion(workspaceId, {
          signals: profile.signals.map((signal) => ({ ...signal, weight: learned[signal.key as keyof CandidateFeatureVector] ?? signal.weight })),
          trainingSampleCount: records.length,
          origin: "learned",
          changeSummary: "Adjusted signal balance from recent reviewer decisions within bounded limits.",
          activate: true,
        });
        criterionUpdated = true;
      }
    }
    return Response.json({ ok: true, candidateId: candidate.id, action, criterionUpdated });
  });
}
