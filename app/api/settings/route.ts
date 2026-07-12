import {
  createCriterionProfileVersion,
  getActiveCriterionProfile,
} from "@/lib/data/talent-radar";

import { getWorkspaceId, readJson, withDashboard } from "../_lib/http";
import { settingsUpdateSchema } from "../_lib/schemas";

export async function GET(request: Request) {
  return withDashboard(request, async () => {
    const criterion = await getActiveCriterionProfile(getWorkspaceId());
    return Response.json({ criterion });
  });
}

async function mutate(request: Request) {
  return withDashboard(request, async () => {
    const input = await readJson(request, settingsUpdateSchema);
    const workspaceId = getWorkspaceId();
    const current = await getActiveCriterionProfile(workspaceId);
    const compact = "candidateCount" in input || "criteria" in input;
    const criterion = await createCriterionProfileVersion(
      workspaceId,
      compact
        ? {
            weeklyCandidateCount: input.candidateCount ?? current?.weeklyCandidateCount,
            signals: input.criteria
              ? Object.entries(input.criteria).map(([key, weight]) => {
                  const existing = current?.signals.find((signal) => signal.key === key);
                  return existing ?? {
                    key,
                    label: key.replace(/([A-Z])/g, " $1").trim(),
                    description: "Reviewer-configured discovery signal",
                    weight,
                    enabled: true,
                  };
                }).map((signal) => ({ ...signal, weight: input.criteria?.[signal.key] ?? signal.weight }))
              : current?.signals,
            origin: "human",
            changeSummary: "Updated dashboard tuning controls.",
            activate: true,
          }
        : { ...input, origin: "human", changeSummary: "Updated discovery criterion.", activate: true },
    );
    return Response.json({ criterion });
  });
}

export const POST = mutate;
export const PATCH = mutate;
