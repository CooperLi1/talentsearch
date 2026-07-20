import { z } from "zod";

export const groundedSourceSchema = z.object({
  label: z.string().min(1).max(120),
  // Provider structured-output schemas do not consistently accept URI format
  // constraints. Exact URL validation happens against the stored evidence set.
  url: z.string().min(1).max(2_048),
});

export const eventSummarySchema = z.object({
  headline: z.string().min(1).max(160),
  summary: z.string().min(1).max(1_200),
  whyNow: z.string().min(1).max(700),
  signalType: z.enum([
    "achievement",
    "building",
    "research",
    "network",
    "trajectory",
    "other",
  ]),
  confidence: z.enum(["high", "medium", "low"]),
  caveats: z.array(z.string().min(1).max(300)).max(6),
  sources: z.array(groundedSourceSchema).min(1).max(12),
});

export const candidateSummarySchema = z.object({
  headline: z.string().min(1).max(160),
  summary: z.string().min(1).max(1_500),
  whyNow: z.string().min(1).max(800),
  earlyness: z.string().min(1).max(700),
  demonstratedStrengths: z.array(z.string().min(1).max(180)).max(8),
  openQuestions: z.array(z.string().min(1).max(240)).max(8),
  confidence: z.enum(["high", "medium", "low"]),
  sources: z.array(groundedSourceSchema).min(1).max(20),
});

export const operatorFactsGenerationSchema = z.object({
  operatorFacts: z.array(z.object({
    text: z.string().min(18).max(190),
    sourceIds: z.array(z.string().min(2).max(12)).min(1).max(2),
  })).min(2).max(3),
});

export const operatorFactsVerificationSchema = z.object({
  verdicts: z.array(z.object({
    factIndex: z.number().int().min(0).max(4),
    supported: z.boolean(),
  })).min(1).max(5),
});

export const candidateSummaryGenerationSchema = candidateSummarySchema
  .omit({ summary: true })
  .extend(operatorFactsGenerationSchema.shape);

export type EventSummary = z.infer<typeof eventSummarySchema>;
export type CandidateSummary = z.infer<typeof candidateSummarySchema>;
