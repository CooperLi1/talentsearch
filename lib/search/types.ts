import type { EventType } from "@/lib/discovery/types";

export type TalentSearchFilters = {
  locations?: string[];
  skills?: string[];
  affiliations?: string[];
  careerStages?: string[];
  eventTypes?: EventType[];
  minScore?: number;
  maxRecognition?: number;
};

export type ParsedTalentQuery = {
  semanticQuery: string;
  keywords: string[];
  filters: TalentSearchFilters;
  sortIntent: "relevance" | "earlyness" | "trajectory" | "achievement";
  limit: number;
};

export type TalentSearchResult = {
  id: string;
  name: string;
  headline?: string;
  summary?: string;
  location?: string;
  score: number;
  similarity?: number;
  keywordRank?: number;
  matchedSignals?: string[];
  sourceUrls?: string[];
};

export type HybridSearchInput = {
  query: string;
  keywords: string[];
  embedding: number[] | null;
  filters: TalentSearchFilters;
  limit: number;
  vectorWeight: number;
  keywordWeight: number;
};

export interface HybridSearchRepository {
  hybridSearch(input: HybridSearchInput): Promise<TalentSearchResult[]>;
}
