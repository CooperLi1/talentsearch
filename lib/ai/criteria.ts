import "server-only";

import { generateText, Output } from "ai";
import { z } from "zod";

import { resolveTextModel } from "@/lib/ai/model";
import { signalsFromWeights } from "@/lib/criteria/signals";
import { sanitizePlainText } from "@/lib/discovery/security";
import type { CriterionProfile } from "@/lib/domain/types";

const priorityWeightsSchema = z.object({
  projectOriginality: z.number().min(0).max(1),
  technicalComplexity: z.number().min(0).max(1),
  trajectoryVelocity: z.number().min(0).max(1),
  networkProximity: z.number().min(0).max(1),
  achievementQuality: z.number().min(0).max(1),
  evidenceDiversity: z.number().min(0).max(1),
  earlyness: z.number().min(0).max(1),
});

const criterionDraftSchema = z.object({
  lookForMarkdown: z.string().min(1).max(2_000),
  avoidMarkdown: z.string().max(2_000),
  minimumScore: z.union([z.literal(12), z.literal(18), z.literal(28)]),
  priorityWeights: priorityWeightsSchema,
});

const EXAMPLES = [
  {
    instruction: "Focus on unusually technical high school and university builders. Favor original systems work over prizes, and keep the queue selective.",
    output: {
      lookForMarkdown: "High school, university, and recent-graduate builders with public evidence of original systems, infrastructure, security, robotics, or scientific-computing work.",
      avoidMarkdown: "Do not prioritize credentials without inspectable work, tutorial clones, or people whose existing recognition already exceeds the evidence of recent output.",
      minimumScore: 28,
      priorityWeights: { projectOriginality: 0.24, technicalComplexity: 0.26, trajectoryVelocity: 0.17, networkProximity: 0.08, achievementQuality: 0.08, evidenceDiversity: 0.09, earlyness: 0.08 },
    },
  },
  {
    instruction: "Broaden toward computational biology and hardware. I care about fast recent progress and credible collaborators, even when the project is early.",
    output: {
      lookForMarkdown: "Early computational-biology and hardware builders with recent technical output, growing project scope, or credible collaboration around inspectable work.",
      avoidMarkdown: "Do not prioritize profiles supported only by affiliations, follower counts, or claims that cannot be traced to public evidence.",
      minimumScore: 12,
      priorityWeights: { projectOriginality: 0.17, technicalComplexity: 0.18, trajectoryVelocity: 0.22, networkProximity: 0.18, achievementQuality: 0.06, evidenceDiversity: 0.1, earlyness: 0.09 },
    },
  },
] as const;

export async function suggestCriterionDraft(input: {
  instruction: string;
  current: CriterionProfile;
}) {
  const model = resolveTextModel(process.env.AI_QUERY_MODEL || process.env.AI_MODEL);
  if (!model) throw new Error("A text model is not configured");
  const instruction = sanitizePlainText(input.instruction, 2_000);
  if (!instruction) throw new Error("Describe what should change");

  const { output } = await generateText({
    model,
    output: Output.object({
      name: "criterion_draft",
      description: "A reviewable draft of talent-discovery criteria",
      schema: criterionDraftSchema,
    }),
    system: `Convert an operator's instruction into a conservative talent-discovery criterion.
Return plain text, not Markdown formatting.
Use only public, work-related evidence. Do not target or infer age, race, ethnicity, gender, health, disability, religion, politics, sexuality, family status, wealth, or other sensitive traits. Career stage is allowed when the operator states it.
Do not invent schools, locations, achievements, or fields. Keep the operator's stated scope.
Weights express relative priority and should sum to roughly 1. The server normalizes them.
Quality cutoffs: 12 is broad, 18 is balanced, 28 is selective.
The result is a draft that a human will review before saving.

Examples:
${JSON.stringify(EXAMPLES)}`,
    prompt: JSON.stringify({
      instruction,
      current: {
        lookForMarkdown: input.current.lookForMarkdown,
        avoidMarkdown: input.current.avoidMarkdown,
        minimumScore: input.current.minimumScore,
        priorityWeights: Object.fromEntries(
          input.current.signals.map((signal) => [signal.key, signal.weight]),
        ),
      },
    }),
    temperature: 0,
    seed: 41_027,
    maxRetries: 1,
    maxOutputTokens: 1_200,
    timeout: { totalMs: 25_000 },
  });

  return {
    lookForMarkdown: sanitizePlainText(output.lookForMarkdown, 2_000),
    avoidMarkdown: sanitizePlainText(output.avoidMarkdown, 2_000),
    minimumScore: output.minimumScore,
    signals: signalsFromWeights(output.priorityWeights),
  };
}
