import { isIP } from "node:net";

import * as cheerio from "cheerio";
import { z } from "zod";

import { isBlockedIp } from "@/lib/discovery/security";

const selectorDocument = cheerio.load(
  "<main><section class='result'><a class='name' href='/person'>Name</a></section></main>",
);

function publicHttpUrl(value: string) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      return false;
    }
    const hostname = url.hostname
      .replace(/^\[|\]$/g, "")
      .replace(/\.$/, "")
      .toLocaleLowerCase("en-US");
    if (
      !hostname ||
      (!hostname.includes(".") && isIP(hostname) === 0) ||
      hostname === "localhost" ||
      hostname === "metadata.google.internal" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal") ||
      hostname.endsWith(".lan") ||
      hostname.endsWith(".home") ||
      hostname.endsWith(".home.arpa")
    ) {
      return false;
    }
    const mappedIpv4 = hostname.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    return (
      isIP(hostname) === 0 ||
      (!isBlockedIp(hostname) && (!mappedIpv4 || !isBlockedIp(mappedIpv4)))
    );
  } catch {
    return false;
  }
}

const publicHttpUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_000)
  .refine(publicHttpUrl, "Use a public HTTP or HTTPS URL without embedded credentials")
  .transform((value) => {
    const url = new URL(value);
    url.hash = "";
    return url.toString();
  });

function safeSelector(value: string) {
  if (
    /[\u0000-\u001f\u007f{};]/u.test(value) ||
    /:(?:has|contains|matches)\s*\(/iu.test(value)
  ) {
    return false;
  }
  try {
    selectorDocument(value);
    return true;
  } catch {
    return false;
  }
}

const selectorSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .refine(safeSelector, "Use a valid, bounded CSS selector");

const boundedText = (max: number) => z.string().trim().min(1).max(max);
const querySchema = boundedText(300).refine(
  (value) => !/[\u0000-\u001f\u007f]/u.test(value),
  "Queries cannot contain control characters",
);

const observationDateSchema = z
  .string()
  .trim()
  .max(50)
  .refine(
    (value) =>
      /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/u.test(
        value,
      ) && Number.isFinite(Date.parse(value)),
    "Use an ISO observation date",
  );

const structuredPageSchema = z
  .object({
    url: publicHttpUrlSchema,
    itemSelector: selectorSchema,
    nameSelector: selectorSchema,
    titleSelector: selectorSchema.optional(),
    descriptionSelector: selectorSchema.optional(),
    linkSelector: selectorSchema.optional(),
    dateSelector: selectorSchema.optional(),
    rankSelector: selectorSchema.optional(),
    affiliationSelector: selectorSchema.optional(),
    eventName: boundedText(200).optional(),
    occurredAt: observationDateSchema.optional(),
    eventType: z
      .enum([
        "competition_result",
        "hackathon_result",
        "fellowship_or_grant",
        "community_recognition",
      ])
      .optional(),
  })
  .strict();

const linkedInProfileUrlSchema = publicHttpUrlSchema
  .refine((value) => {
    const url = new URL(value);
    const hostname = url.hostname.toLocaleLowerCase("en-US");
    return (
      url.protocol === "https:" &&
      (hostname === "linkedin.com" || hostname.endsWith(".linkedin.com")) &&
      /^\/in\/[^/]+\/?$/u.test(url.pathname)
    );
  }, "Use a public LinkedIn member profile URL")
  .transform((value) => {
    const url = new URL(value);
    url.search = "";
    return url.toString();
  });

const manualProfileSchema = z
  .object({
    name: boundedText(200),
    profileUrl: linkedInProfileUrlSchema,
    headline: boundedText(500).optional(),
    biography: boundedText(2_000).optional(),
    location: boundedText(300).optional(),
    affiliations: z.array(boundedText(300)).max(20).optional(),
    websiteUrl: publicHttpUrlSchema.optional(),
    observedAt: observationDateSchema.optional(),
    note: boundedText(2_000).optional(),
    provenanceUrl: publicHttpUrlSchema.optional(),
    reviewed: z.literal(true, "Confirm that the LinkedIn URL belongs to this person"),
  })
  .strict();

const sourceOptionsSchema = z
  .object({
    complexityKeywords: z.array(boundedText(100)).max(30).optional(),
    maxContests: z.number().int().min(1).max(5).optional(),
    feed: z.enum(["newstories", "beststories", "topstories", "showstories"]).optional(),
    minimumScore: z.number().int().min(0).max(10_000).optional(),
    topicKeywords: z.array(boundedText(100)).max(30).optional(),
    requireTopicMatch: z.boolean().optional(),
    maxQueries: z.number().int().min(1).max(5).optional(),
    maxResults: z.number().int().min(1).max(12).optional(),
    pages: z.array(structuredPageSchema).max(20).optional(),
    profiles: z.array(manualProfileSchema).max(100).optional(),
  })
  .strict();

function duplicateIndexes(values: string[]) {
  const seen = new Set<string>();
  const duplicates: number[] = [];
  values.forEach((value, index) => {
    const key = value.toLocaleLowerCase("en-US");
    if (seen.has(key)) duplicates.push(index);
    seen.add(key);
  });
  return duplicates;
}

const editableSourceConfigSchema = z
  .object({
    queries: z.array(querySchema).max(8).optional(),
    urls: z.array(publicHttpUrlSchema).max(30).optional(),
    lookbackDays: z.number().int().min(1).max(365).optional(),
    maxItems: z.number().int().min(1).max(500).optional(),
    options: sourceOptionsSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!Object.keys(value).length) {
      context.addIssue({
        code: "custom",
        message: "At least one configuration field is required",
      });
    }
    for (const index of duplicateIndexes(value.queries ?? [])) {
      context.addIssue({ code: "custom", path: ["queries", index], message: "Duplicate query" });
    }
    for (const index of duplicateIndexes(value.urls ?? [])) {
      context.addIssue({ code: "custom", path: ["urls", index], message: "Duplicate URL" });
    }
    for (const index of duplicateIndexes(value.options?.complexityKeywords ?? [])) {
      context.addIssue({
        code: "custom",
        path: ["options", "complexityKeywords", index],
        message: "Duplicate keyword",
      });
    }
    for (const index of duplicateIndexes(value.options?.topicKeywords ?? [])) {
      context.addIssue({
        code: "custom",
        path: ["options", "topicKeywords", index],
        message: "Duplicate topic",
      });
    }
    for (const index of duplicateIndexes(
      value.options?.pages?.map((page) => page.url) ?? [],
    )) {
      context.addIssue({
        code: "custom",
        path: ["options", "pages", index, "url"],
        message: "Duplicate results page",
      });
    }
    for (const index of duplicateIndexes(
      value.options?.profiles?.map((profile) => profile.profileUrl) ?? [],
    )) {
      context.addIssue({
        code: "custom",
        path: ["options", "profiles", index, "profileUrl"],
        message: "Duplicate profile",
      });
    }
  });

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
      sources: z.array(z.string().trim().min(1).max(200)).max(12).optional(),
      statuses: z
        .array(
          z.enum([
            "new",
            "watching",
            "saved",
            "contacted",
            "interviewing",
            "fellow",
            "passed",
            "archived",
          ]),
        )
        .max(8)
        .optional(),
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
        "hugging-face",
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

const sourceIdSchema = z.number().int().positive();

export const sourceUpdateSchema = z.union([
  z.object({ id: sourceIdSchema, enabled: z.boolean() }).strict(),
  z.object({ id: sourceIdSchema, config: editableSourceConfigSchema }).strict(),
]);

const fullSettingsSchema = z.object({
  lookForMarkdown: z.string().max(10_000),
  avoidMarkdown: z.string().max(10_000),
  minimumScore: z.number().min(0).max(100),
  minimumConfidence: z.number().min(0).max(1),
  weeklyCandidateCount: z.number().int().min(1).max(100),
  digestCadence: z.enum(["daily", "twice_weekly", "weekly", "biweekly"]).default("weekly"),
  digestDaysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7)
    .transform((days) => [...new Set(days)].sort((left, right) => left - right)),
  digestDeliveryHourUtc: z.number().int().min(0).max(23).default(15),
  digestDeliveryMinuteUtc: z.union([z.literal(0), z.literal(15), z.literal(30), z.literal(45)]).default(0),
  digestPreparationLeadHours: z.number().int().min(1).max(12).default(3),
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

export const criterionSuggestionSchema = z.object({
  instruction: z.string().trim().min(10).max(2_000),
}).strict();
