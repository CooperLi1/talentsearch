import { z } from "zod";

import { SOURCE_KINDS, type ConnectorSettings, type SourceKind } from "./types";

const connectorSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  queries: z.array(z.string().trim().min(1).max(500)).max(100).optional(),
  seedIds: z.array(z.string().trim().min(1).max(500)).max(500).optional(),
  urls: z.array(z.string().url()).max(100).optional(),
  maxItems: z.number().int().min(1).max(500).optional(),
  lookbackDays: z.number().int().min(1).max(730).optional(),
  options: z.record(z.string(), z.unknown()).optional(),
});

const configurationSchema = z.object({
  connectors: z.partialRecord(z.enum(SOURCE_KINDS), connectorSettingsSchema).default({}),
  enrichTopCandidates: z.number().int().min(0).max(100).default(15),
  graphDepth: z.number().int().min(0).max(3).default(1),
  graphNodeLimit: z.number().int().min(0).max(1_000).default(200),
  minimumScore: z.number().min(0).max(100).default(55),
  scoringWeights: z.object({
    achievementQuality: z.number().min(0).max(1).default(.25),
    trajectoryVelocity: z.number().min(0).max(1).default(.17),
    projectOriginality: z.number().min(0).max(1).default(.14),
    technicalComplexity: z.number().min(0).max(1).default(.15),
    networkProximity: z.number().min(0).max(1).default(.12),
    evidenceDiversity: z.number().min(0).max(1).default(.08),
    earlyness: z.number().min(0).max(1).default(.09),
  }).default({
    achievementQuality: .25,
    trajectoryVelocity: .17,
    projectOriginality: .14,
    technicalComplexity: .15,
    networkProximity: .12,
    evidenceDiversity: .08,
    earlyness: .09,
  }),
});

export type DiscoveryConfiguration = z.infer<typeof configurationSchema>;

const defaults: Record<SourceKind, ConnectorSettings> = {
  github: { enabled: true, maxItems: 35, lookbackDays: 14 },
  gitlab: { enabled: true, maxItems: 25, lookbackDays: 14 },
  openalex: { enabled: true, maxItems: 45, lookbackDays: 21 },
  crossref: { enabled: true, maxItems: 35, lookbackDays: 21 },
  arxiv: { enabled: true, maxItems: 35, lookbackDays: 14 },
  "semantic-scholar": { enabled: true, maxItems: 35, lookbackDays: 30 },
  codeforces: { enabled: true, maxItems: 25, lookbackDays: 14 },
  "hacker-news": { enabled: true, maxItems: 35, lookbackDays: 7 },
  rss: { enabled: false, maxItems: 60, urls: [] },
  "technical-blogs": { enabled: false, maxItems: 60, urls: [] },
  "project-launches": { enabled: false, maxItems: 60, urls: [] },
  "structured-results": { enabled: false, maxItems: 100 },
  "competition-results": { enabled: false, maxItems: 100 },
  "science-fairs": { enabled: false, maxItems: 100 },
  hackathons: { enabled: false, maxItems: 100 },
  "web-presence": { enabled: true, maxItems: 60, urls: [] },
  x: { enabled: false, maxItems: 30, queries: [] },
  "linkedin-manual": { enabled: false, maxItems: 100 },
  "brave-enrichment": { enabled: Boolean(process.env.BRAVE_SEARCH_API_KEY), maxItems: 8 },
};

export function getDefaultConnectorSettings(): Record<SourceKind, ConnectorSettings> {
  return structuredClone(defaults);
}

export function parseDiscoveryConfiguration(
  input?: unknown,
): DiscoveryConfiguration & { connectors: Partial<Record<SourceKind, ConnectorSettings>> } {
  let candidate = input;
  if (candidate === undefined && process.env.DISCOVERY_CONNECTOR_CONFIG) {
    try {
      candidate = JSON.parse(process.env.DISCOVERY_CONNECTOR_CONFIG);
    } catch (error) {
      throw new Error(
        `DISCOVERY_CONNECTOR_CONFIG is invalid JSON: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }
  const parsed = configurationSchema.parse(candidate ?? {});
  const connectors = getDefaultConnectorSettings();
  for (const kind of SOURCE_KINDS) {
    if (parsed.connectors[kind]) {
      connectors[kind] = { ...connectors[kind], ...parsed.connectors[kind] };
    }
  }
  if (process.env.X_BEARER_TOKEN && connectors.x.queries?.length) connectors.x.enabled = true;
  if (connectors.rss.urls?.length) connectors.rss.enabled = true;
  if (connectors["technical-blogs"].urls?.length) connectors["technical-blogs"].enabled = true;
  if (connectors["project-launches"].urls?.length) connectors["project-launches"].enabled = true;
  if (connectors["web-presence"].urls?.length) connectors["web-presence"].enabled = true;
  if (
    Array.isArray(connectors["structured-results"].options?.pages) &&
    connectors["structured-results"].options.pages.length > 0
  ) {
    connectors["structured-results"].enabled = true;
  }
  for (const kind of ["competition-results", "science-fairs", "hackathons"] as const) {
    if (Array.isArray(connectors[kind].options?.pages) && connectors[kind].options.pages.length > 0) {
      connectors[kind].enabled = true;
    }
  }
  if (Array.isArray(connectors["linkedin-manual"].options?.profiles)) {
    connectors["linkedin-manual"].enabled = true;
  }
  return { ...parsed, connectors };
}
