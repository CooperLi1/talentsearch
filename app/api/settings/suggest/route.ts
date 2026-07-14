import { suggestCriterionDraft } from "@/lib/ai/criteria";
import { getActiveCriterionProfile } from "@/lib/data/talent-radar";

import { ApiError, getWorkspaceId, readJson, withDashboard } from "../../_lib/http";
import { criterionSuggestionSchema } from "../../_lib/schemas";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request) {
  return withDashboard(request, async () => {
    const input = await readJson(request, criterionSuggestionSchema);
    const current = await getActiveCriterionProfile(getWorkspaceId());
    if (!current) throw new ApiError(503, "Review criteria are not configured");
    try {
      const draft = await suggestCriterionDraft({ instruction: input.instruction, current });
      return Response.json({ draft });
    } catch (error) {
      if (error instanceof Error && error.message === "A text model is not configured") {
        throw new ApiError(503, error.message);
      }
      throw error;
    }
  });
}
