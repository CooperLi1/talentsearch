import { updateSourceEnabled } from "@/lib/data/talent-radar";
import type { SourceSetupRequirement } from "@/lib/data/contracts";

import { ApiError, getWorkspaceId, readJson, withDashboard } from "../_lib/http";
import { sourceUpdateSchema } from "../_lib/schemas";

export const runtime = "nodejs";

const setupMessages: Record<SourceSetupRequirement, string> = {
  x_connection: "Finish the X connection before including this source.",
  web_search_connection: "Finish public web search setup before including this source.",
  linkedin_profiles: "Add at least one reviewed LinkedIn profile before including this source.",
  feed_urls: "Add at least one feed or site before including this source.",
  structured_pages: "Add at least one reviewed results page before including this source.",
  unsupported_source: "Finish setting up this source before including it.",
};

export async function PATCH(request: Request) {
  return withDashboard(request, async () => {
    const input = await readJson(request, sourceUpdateSchema);
    const result = await updateSourceEnabled(getWorkspaceId(), input.id, input.enabled);

    if (!result.ok) {
      if (result.reason === "not_found") throw new ApiError(404, "Source not found");
      throw new ApiError(409, setupMessages[result.requirement]);
    }

    return Response.json({ source: result.source });
  });
}
