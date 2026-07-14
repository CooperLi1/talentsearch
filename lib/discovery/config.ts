import { z } from "zod";

import { SOURCE_KINDS, type ConnectorSettings, type SourceKind } from "./types";

const connectorSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  queries: z.array(z.string().trim().min(1).max(500)).max(8).optional(),
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
  minimumScore: z.number().min(0).max(100).default(25),
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

// These are intentionally topical rather than popularity-driven. Connector
// adapters add their rolling lookback filters at request time, so the stored
// queries stay readable and do not go stale in persisted source settings.
export const RECOMMENDED_CONNECTOR_QUERIES = {
  github: [
    "compiler stars:<300 size:>20",
    "database stars:<300 size:>20",
    "robotics stars:<300 size:>20",
    "inference engine stars:<300 size:>20",
    "cryptography stars:<300 size:>20",
    "bioinformatics stars:<300 size:>20",
    "embedded systems stars:<300 size:>20",
    "developer tools stars:<300 size:>20",
  ],
  gitlab: [
    "compiler",
    "database",
    "robotics",
    "inference",
    "cryptography",
    "bioinformatics",
    "scientific computing",
    "developer tools",
  ],
  openalex: [
    "efficient machine learning systems",
    "robot learning and autonomous systems",
    "computer security and applied cryptography",
    "programming languages and formal methods",
    "distributed systems and databases",
    "computational biology and bioengineering",
    "scientific computing and simulation",
    "human computer interaction and assistive technology",
  ],
  crossref: [
    "machine learning systems",
    "robot learning and autonomous systems",
    "computer security and applied cryptography",
    "programming languages and formal methods",
    "distributed systems and databases",
    "computational biology and bioengineering",
    "scientific computing and simulation",
    "human computer interaction and assistive technology",
  ],
  arxiv: [
    "cat:cs.AI OR cat:cs.LG",
    "cat:cs.RO",
    "cat:cs.CR",
    "cat:cs.DC OR cat:cs.OS",
    "cat:cs.PL OR cat:cs.SE",
    "cat:cs.AR",
    "cat:q-bio.QM OR cat:q-bio.BM",
    "cat:physics.comp-ph OR cat:eess.SY",
  ],
  "semantic-scholar": [
    "machine learning systems",
    "robot learning and autonomous systems",
    "computer security and applied cryptography",
    "programming languages and formal methods",
    "distributed systems and databases",
    "computational biology and bioengineering",
    "scientific computing and simulation",
    "human computer interaction and assistive technology",
  ],
  "hugging-face": [
    "robotics",
    "compiler",
    "scientific computing",
    "computer vision",
    "reinforcement learning",
    "bioinformatics",
    "speech technology",
    "developer tools",
  ],
  x: [
    '("open sourced" OR "I built" OR "I made") (compiler OR database OR robotics OR hardware)',
    '("open sourced" OR "I built") (inference OR model OR agent OR benchmark)',
    '(paper OR preprint) (cryptography OR bioinformatics OR robotics OR systems)',
    '(won OR finalist OR medalist) (olympiad OR hackathon OR "science fair")',
    '("looking for contributors" OR "first release" OR "v0.1") (github OR gitlab)',
  ],
} as const;

export const RECOMMENDED_TECHNICAL_COMPLEXITY_KEYWORDS = [
  "compiler",
  "interpreter",
  "database",
  "storage engine",
  "distributed system",
  "consensus",
  "runtime",
  "operating system",
  "kernel",
  "hypervisor",
  "protocol",
  "cryptography",
  "zero knowledge",
  "formal verification",
  "robotics",
  "embedded",
  "firmware",
  "fpga",
  "simulation",
  "scientific computing",
  "bioinformatics",
  "machine learning framework",
  "inference engine",
  "vector database",
  "observability",
  "debugger",
  "static analysis",
  "network stack",
  "scheduler",
  "query optimizer",
] as const;

export const RECOMMENDED_HACKER_NEWS_TOPICS = [
  "compiler",
  "database",
  "distributed systems",
  "robotics",
  "embedded",
  "hardware",
  "machine learning",
  "inference",
  "security",
  "cryptography",
  "formal verification",
  "bioinformatics",
  "scientific computing",
  "developer tools",
  "open source",
  "protocol",
  "simulation",
  "programming language",
  "operating system",
] as const;

export const VERIFIED_TECHNICAL_FEEDS = [
  "https://github.blog/feed/",
  "https://hacks.mozilla.org/feed/",
  "https://blog.cloudflare.com/rss/",
  "https://projectzero.google/feed.xml",
  "https://about.gitlab.com/atom.xml",
] as const;

const defaults: Record<SourceKind, ConnectorSettings> = {
  github: {
    enabled: true,
    queries: [...RECOMMENDED_CONNECTOR_QUERIES.github],
    maxItems: 35,
    lookbackDays: 14,
    options: { complexityKeywords: [...RECOMMENDED_TECHNICAL_COMPLEXITY_KEYWORDS] },
  },
  gitlab: {
    enabled: true,
    queries: [...RECOMMENDED_CONNECTOR_QUERIES.gitlab],
    maxItems: 25,
    lookbackDays: 14,
    options: { complexityKeywords: [...RECOMMENDED_TECHNICAL_COMPLEXITY_KEYWORDS] },
  },
  openalex: {
    enabled: Boolean(process.env.OPENALEX_API_KEY?.trim()),
    queries: [...RECOMMENDED_CONNECTOR_QUERIES.openalex],
    maxItems: 45,
    lookbackDays: 21,
  },
  crossref: {
    enabled: true,
    queries: [...RECOMMENDED_CONNECTOR_QUERIES.crossref],
    maxItems: 35,
    lookbackDays: 21,
  },
  arxiv: {
    enabled: true,
    queries: [...RECOMMENDED_CONNECTOR_QUERIES.arxiv],
    maxItems: 35,
    lookbackDays: 14,
  },
  "semantic-scholar": {
    enabled: true,
    queries: [...RECOMMENDED_CONNECTOR_QUERIES["semantic-scholar"]],
    maxItems: 35,
    lookbackDays: 30,
  },
  "hugging-face": {
    enabled: false,
    queries: [...RECOMMENDED_CONNECTOR_QUERIES["hugging-face"]],
    maxItems: 45,
    lookbackDays: 30,
  },
  codeforces: { enabled: true, maxItems: 25, lookbackDays: 14 },
  "hacker-news": {
    enabled: true,
    maxItems: 35,
    lookbackDays: 7,
    options: {
      feed: "showstories",
      minimumScore: 2,
      topicKeywords: [...RECOMMENDED_HACKER_NEWS_TOPICS],
      requireTopicMatch: false,
    },
  },
  rss: { enabled: false, maxItems: 60, urls: [] },
  "technical-blogs": {
    enabled: true,
    maxItems: 60,
    urls: [...VERIFIED_TECHNICAL_FEEDS],
  },
  "project-launches": { enabled: false, maxItems: 60, urls: [] },
  "structured-results": { enabled: false, maxItems: 100 },
  "competition-results": { enabled: false, maxItems: 100 },
  "science-fairs": { enabled: false, maxItems: 100 },
  hackathons: { enabled: false, maxItems: 100 },
  "web-presence": { enabled: true, maxItems: 60, urls: [] },
  x: {
    enabled: false,
    maxItems: 30,
    queries: [...RECOMMENDED_CONNECTOR_QUERIES.x],
  },
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
  if (
    process.env.X_BEARER_TOKEN &&
    process.env.X_DATA_USE_APPROVED === "true" &&
    connectors.x.queries?.length
  ) {
    connectors.x.enabled = true;
  }
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
