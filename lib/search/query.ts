import { generateText, Output } from "ai";
import { z } from "zod";

import { sanitizePlainText } from "@/lib/discovery/security";
import type { ParsedTalentQuery } from "./types";
import { resolveTextModel } from "@/lib/ai/model";

const eventTypes = [
  "project_created",
  "project_momentum",
  "open_source_contribution",
  "paper_published",
  "competition_result",
  "hackathon_result",
  "community_recognition",
  "social_graph_signal",
  "profile_observed",
  "fellowship_or_grant",
  "other",
] as const;

const parsedQuerySchema = z.object({
  semanticQuery: z.string().min(1).max(1_000),
  keywords: z.array(z.string().min(1).max(80)).max(20),
  filters: z.object({
    locations: z.array(z.string().min(1).max(120)).max(10).optional(),
    skills: z.array(z.string().min(1).max(120)).max(20).optional(),
    affiliations: z.array(z.string().min(1).max(160)).max(10).optional(),
    careerStages: z.array(z.string().min(1).max(120)).max(10).optional(),
    eventTypes: z.array(z.enum(eventTypes)).max(10).optional(),
    minScore: z.number().min(0).max(100).optional(),
    maxRecognition: z.number().min(0).optional(),
  }),
  sortIntent: z.enum(["relevance", "earlyness", "trajectory", "achievement"]),
  limit: z.number().int().min(1).max(100),
});

function fallback(query: string, requestedLimit: number): ParsedTalentQuery {
  const normalized = sanitizePlainText(query, 1_000);
  const keywords = [...new Set(
    normalized
      .toLocaleLowerCase("en-US")
      .split(/[^a-z0-9+#.-]+/)
      .filter((word) => word.length >= 2),
  )].slice(0, 20);
  return {
    semanticQuery: normalized,
    keywords,
    filters: {},
    sortIntent: /under[- ]?discovered|early|unknown|low profile/.test(normalized.toLowerCase())
      ? "earlyness"
      : /fast|trajectory|momentum|rising/.test(normalized.toLowerCase())
        ? "trajectory"
        : "relevance",
    limit: Math.min(100, Math.max(1, requestedLimit)),
  };
}

export async function parseTalentQuery(
  query: string,
  requestedLimit = 20,
): Promise<ParsedTalentQuery> {
  const safeQuery = sanitizePlainText(query, 1_000);
  const model = resolveTextModel(
    process.env.AI_QUERY_MODEL || process.env.AI_MODEL || process.env.AI_SUMMARY_MODEL,
  );
  if (!model) {
    return fallback(safeQuery, requestedLimit);
  }
  try {
    const { output } = await generateText({
      model,
      output: Output.object({ schema: parsedQuerySchema }),
      system: `Translate a talent search into safe retrieval constraints. Never derive or filter by protected or sensitive traits. Do not add facts not present in the query. Keep the semantic query rich enough for embedding search.`,
      prompt: `Query: ${JSON.stringify(safeQuery)}\nRequested result count: ${requestedLimit}`,
      timeout: { totalMs: 20_000 },
      maxOutputTokens: 900,
    });
    return { ...output, limit: Math.min(output.limit, requestedLimit, 100) };
  } catch {
    return fallback(safeQuery, requestedLimit);
  }
}
