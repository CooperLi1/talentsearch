import { embedQuery } from "@/lib/ai/embeddings";
import { toPeopleCandidateView } from "@/lib/candidates/people-view";
import { searchCandidates } from "@/lib/data/talent-radar";
import { parseTalentQuery } from "@/lib/search/query";

import { getWorkspaceId, readJson, withDashboard } from "../_lib/http";
import { searchRequestSchema } from "../_lib/schemas";
import type { CandidateStatus } from "@/lib/domain/types";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return withDashboard(request, async () => {
    const input = await readJson(request, searchRequestSchema);
    const interpretedQuery = await parseTalentQuery(input.query, input.limit);
    const embedding = await embedQuery(interpretedQuery.semanticQuery).catch(() => null);
    const skills = input.filters?.skills ?? interpretedQuery.filters.skills;
    const minimumScore = input.filters?.minScore ?? interpretedQuery.filters.minScore;
    const candidates = await searchCandidates(
      interpretedQuery.semanticQuery,
      {
        limit: input.limit,
        minimumScore,
        domains: skills,
        careerStages: input.filters?.careerStages ?? interpretedQuery.filters.careerStages,
        eventTypes: input.filters?.eventTypes ?? interpretedQuery.filters.eventTypes,
        locations: input.filters?.locations ?? interpretedQuery.filters.locations,
        sources: input.filters?.sources,
        statuses: input.filters?.statuses as CandidateStatus[] | undefined,
        embedding: embedding ?? undefined,
        semanticWeight: embedding ? 0.62 : 0,
      },
      getWorkspaceId(),
    );

    const results = candidates.map((candidate) => {
      const semanticSimilarity = Number(
        candidate.scoreComponents.semanticSimilarity ??
          candidate.scoreComponents.similarity ??
          candidate.scoreComponents.combinedScore ??
          0,
      );
      const rationale = [
        candidate.whyNowMarkdown,
        candidate.domains.length
          ? `Signals: ${candidate.domains.slice(0, 5).join(", ")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      return {
        candidate,
        view: toPeopleCandidateView(candidate),
        similarity: Number.isFinite(semanticSimilarity) ? semanticSimilarity : 0,
        rationale: rationale || undefined,
      };
    });

    return Response.json({
      results,
      interpretedQuery,
      mode: embedding ? "hybrid" : "keyword",
    });
  });
}
