import { embedQuery } from "@/lib/ai/embeddings";
import { parseTalentQuery } from "./query";
import type {
  HybridSearchRepository,
  TalentSearchFilters,
  TalentSearchResult,
} from "./types";

function mergeFilters(
  parsed: TalentSearchFilters,
  explicit?: TalentSearchFilters,
): TalentSearchFilters {
  if (!explicit) return parsed;
  return {
    ...parsed,
    ...explicit,
    locations: explicit.locations ?? parsed.locations,
    skills: explicit.skills ?? parsed.skills,
    affiliations: explicit.affiliations ?? parsed.affiliations,
    careerStages: explicit.careerStages ?? parsed.careerStages,
    eventTypes: explicit.eventTypes ?? parsed.eventTypes,
  };
}

export async function hybridTalentSearch(input: {
  repository: HybridSearchRepository;
  query: string;
  filters?: TalentSearchFilters;
  limit?: number;
}): Promise<{
  parsedQuery: Awaited<ReturnType<typeof parseTalentQuery>>;
  mode: "hybrid" | "keyword";
  results: TalentSearchResult[];
}> {
  const requestedLimit = Math.min(100, Math.max(1, input.limit ?? 20));
  const parsedQuery = await parseTalentQuery(input.query, requestedLimit);
  const embedding = await embedQuery(parsedQuery.semanticQuery).catch(() => null);
  const filters = mergeFilters(parsedQuery.filters, input.filters);
  const results = await input.repository.hybridSearch({
    query: parsedQuery.semanticQuery,
    keywords: parsedQuery.keywords,
    embedding,
    filters,
    limit: Math.min(requestedLimit, parsedQuery.limit),
    vectorWeight: embedding ? 0.62 : 0,
    keywordWeight: embedding ? 0.38 : 1,
  });
  return { parsedQuery: { ...parsedQuery, filters }, mode: embedding ? "hybrid" : "keyword", results };
}
