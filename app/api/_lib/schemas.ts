import { z } from "zod";

export const workspaceIdSchema = z.string().regex(/^\d+$/, "workspaceId must be numeric").optional();

export const eventTypeSchema = z.enum([
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
]);

export const searchRequestSchema = z.object({
  query: z.string().trim().min(2).max(1_000),
  limit: z.number().int().min(1).max(100).default(20),
  filters: z
    .object({
      locations: z.array(z.string().trim().min(1).max(120)).max(10).optional(),
      skills: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
      affiliations: z.array(z.string().trim().min(1).max(160)).max(10).optional(),
      careerStages: z.array(z.string().trim().min(1).max(120)).max(10).optional(),
      eventTypes: z.array(eventTypeSchema).max(10).optional(),
      minScore: z.number().min(0).max(100).optional(),
      maxRecognition: z.number().min(0).optional(),
    })
    .optional(),
});

export const feedbackRequestSchema = z.object({
  candidateId: z.string().trim().min(1).max(160).regex(/^[a-zA-Z0-9_-]+$/),
  action: z.enum([
    "save",
    "pass",
    "watch",
    "refer",
    "contact",
    "interview",
    "accept",
    "reject",
    "correct_identity",
  ]).optional(),
  decision: z.enum(["shortlist", "watch", "pass"]).optional(),
  reasonCode: z.string().trim().min(1).max(120).optional(),
  note: z.string().trim().max(2_000).optional(),
  context: z.record(z.string(), z.unknown()).optional(),
}).refine((value) => Boolean(value.action || value.decision), "action or decision is required");

export const subscriberCreateSchema = z.object({
  email: z.email().max(320).transform((value) => value.trim().toLocaleLowerCase("en-US")),
  displayName: z.string().trim().max(200).nullable().optional(),
  status: z.enum(["active", "paused"]).optional(),
});

export const subscriberUpdateSchema = subscriberCreateSchema
  .partial()
  .extend({
    id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    deliveryStatus: z.enum(["never_sent", "delivered", "bounced", "complained", "failed"]).optional(),
  })
  .refine(
    (value) => Object.keys(value).some((key) => key !== "id" && value[key as keyof typeof value] !== undefined),
    "At least one field must be updated",
  );

export const subscriberDeleteSchema = z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]+$/) });

export const discoveryRunSchema = z.object({
  sourceKinds: z
    .array(
      z.enum([
        "github",
        "gitlab",
        "openalex",
        "crossref",
        "arxiv",
        "semantic-scholar",
        "codeforces",
        "hacker-news",
        "rss",
        "technical-blogs",
        "project-launches",
        "structured-results",
        "competition-results",
        "science-fairs",
        "hackathons",
        "web-presence",
        "x",
        "linkedin-manual",
        "brave-enrichment",
      ]),
    )
    .max(12)
    .optional(),
  eventLimit: z.number().int().min(1).max(500).default(150),
});

export const sourceUpdateSchema = z
  .object({
    id: z.number().int().positive(),
    enabled: z.boolean(),
  })
  .strict();

const fullSettingsSchema = z.object({
  lookForMarkdown: z.string().max(10_000),
  avoidMarkdown: z.string().max(10_000),
  minimumScore: z.number().min(0).max(100),
  minimumConfidence: z.number().min(0).max(1),
  weeklyCandidateCount: z.number().int().min(1).max(100),
  explorationRate: z.number().min(0).max(0.5),
  learningRate: z.number().min(0).max(0.05),
  signals: z
    .array(
      z.object({
        key: z.string().regex(/^[a-z][a-zA-Z0-9_-]*$/),
        label: z.string().trim().min(1).max(120),
        description: z.string().trim().max(500),
        weight: z.number().min(0).max(1),
        enabled: z.boolean(),
      }),
    )
    .min(1)
    .max(30),
});

const compactSettingsSchema = z.object({
  candidateCount: z.number().int().min(1).max(100).optional(),
  criteria: z.record(z.string(), z.number().min(0).max(1)).optional(),
}).refine((value) => value.candidateCount !== undefined || value.criteria !== undefined, "No settings supplied");

export const settingsUpdateSchema = z.union([fullSettingsSchema, compactSettingsSchema]);
