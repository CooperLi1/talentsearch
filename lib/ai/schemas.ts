import { z } from "zod";

export const groundedSourceSchema = z.object({
  label: z.string().min(1).max(120),
  url: z.string().url(),
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

export type EventSummary = z.infer<typeof eventSummarySchema>;
export type CandidateSummary = z.infer<typeof candidateSummarySchema>;
