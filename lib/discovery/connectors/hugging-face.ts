import { smartFetch } from "../http";
import { sanitizePlainText } from "../security";
import type {
  ConnectorRunContext,
  ConnectorRunResult,
  DiscoveryConnector,
  DiscoveryEvent,
  PersonObservation,
} from "../types";
import { asNumber, createDiscoveryEvent, mapLimit } from "./shared";

const HUB_ORIGIN = "https://huggingface.co";
const ARTIFACT_KINDS = ["model", "dataset", "space"] as const;
const MAX_QUERIES = 8;
const MAX_ARTIFACTS = 75;
const MAX_PROFILE_LOOKUPS = 20;

type HubArtifactKind = (typeof ARTIFACT_KINDS)[number];

type HubSibling = { rfilename?: string };

type HubArtifact = {
  _id?: string;
  id?: string;
  modelId?: string;
  author?: string;
  cardData?: Record<string, unknown> | null;
  createdAt?: string;
  disabled?: boolean;
  downloads?: number;
  gated?: boolean | string;
  lastModified?: string;
  library_name?: string;
  likes?: number;
  pipeline_tag?: string;
  private?: boolean;
  sdk?: string;
  sha?: string;
  siblings?: HubSibling[];
  tags?: string[];
};

type HubUserOverview = {
  _id?: string;
  avatarUrl?: string;
  createdAt?: string;
  fullname?: string;
  numDatasets?: number;
  numFollowers?: number;
  numModels?: number;
  numPapers?: number;
  numSpaces?: number;
  type?: string;
  user?: string;
};

type VerifiedHubUser = HubUserOverview & {
  _id: string;
  type: "user";
  user: string;
};

type MetadataComplexity = {
  score: number;
  confidence: number;
  indicators: string[];
};

function hubHeaders(): HeadersInit {
  const token = process.env.HF_TOKEN?.trim();
  return token ? { authorization: `Bearer ${token}` } : {};
}

function artifactPath(kind: HubArtifactKind) {
  if (kind === "model") return "models";
  if (kind === "dataset") return "datasets";
  return "spaces";
}

function artifactId(artifact: HubArtifact) {
  return sanitizePlainText(artifact.id || artifact.modelId, 500);
}

function artifactName(id: string) {
  return sanitizePlainText(id.split("/").at(-1), 200) || id;
}

function artifactUrl(kind: HubArtifactKind, id: string) {
  const prefix = kind === "model" ? "" : `${artifactPath(kind)}/`;
  return `${HUB_ORIGIN}/${prefix}${id.split("/").map(encodeURIComponent).join("/")}`;
}

function profileUrl(username: string) {
  return `${HUB_ORIGIN}/${encodeURIComponent(username)}`;
}

function avatarUrl(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const parsed = new URL(value, HUB_ORIGIN);
    return parsed.protocol === "https:" ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

function asPlainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function analyzeHuggingFaceArtifactMetadata(
  kind: HubArtifactKind,
  artifact: HubArtifact,
): MetadataComplexity {
  const files = (artifact.siblings ?? [])
    .map((sibling) => sanitizePlainText(sibling.rfilename, 300).toLowerCase())
    .filter(Boolean)
    .slice(0, 100);
  const tags = (artifact.tags ?? [])
    .map((tag) => sanitizePlainText(tag, 100).toLowerCase())
    .filter(Boolean)
    .slice(0, 50);
  const card = asPlainObject(artifact.cardData);
  const sdk = sanitizePlainText(artifact.sdk ?? card.sdk, 100).toLowerCase();
  const indicators = new Set<string>();

  if (files.some((file) => /(^|\/)(dockerfile|containerfile)$/u.test(file))) {
    indicators.add("containerized runtime");
  }
  if (files.some((file) => /(^|\/)(requirements[^/]*\.txt|pyproject\.toml|package\.json|cargo\.toml)$/u.test(file))) {
    indicators.add("declared runtime dependencies");
  }
  if (files.some((file) => /(^|\/)(tests?|specs?)\//u.test(file))) {
    indicators.add("test suite");
  }
  if (files.some((file) => /(^|\/)\.github\/workflows\//u.test(file))) {
    indicators.add("automated validation");
  }
  if (files.some((file) => /\.(?:c|cc|cpp|cu|cuh|go|java|jl|py|rs|swift|ts|tsx)$/u.test(file))) {
    indicators.add("authored implementation files");
  }
  if (files.some((file) => /(?:benchmark|eval|leaderboard)/u.test(file))) {
    indicators.add("evaluation artifacts");
  }
  if (files.some((file) => /(?:adapter_config|config)\.json$/u.test(file))) {
    indicators.add("reproducible configuration");
  }
  if (tags.some((tag) => /(?:robotics|reinforcement-learning|text-generation|computer-vision|bioinformatics|scientific)/u.test(tag))) {
    indicators.add("specialized technical domain");
  }
  if (kind === "space" && sdk === "docker") indicators.add("custom application runtime");
  if (kind === "dataset" && tags.some((tag) => /(?:parquet|webdataset|geospatial|time-series)/u.test(tag))) {
    indicators.add("structured data pipeline");
  }
  if (kind === "model" && (artifact.library_name || artifact.pipeline_tag)) {
    indicators.add("documented model integration");
  }

  const evidenceCount = indicators.size;
  return {
    score: Math.min(1, 0.08 + evidenceCount * 0.12),
    confidence: files.length ? Math.min(0.75, 0.3 + evidenceCount * 0.08) : 0.2,
    indicators: [...indicators].slice(0, 8),
  };
}

export function isPublicHuggingFaceArtifact(kind: HubArtifactKind, artifact: HubArtifact) {
  if (artifact.private !== false || artifact.disabled === true) return false;
  if (kind !== "space" && artifact.gated !== false) return false;
  return Boolean(artifactId(artifact) && artifact.author && artifact._id);
}

function personObservation(user: VerifiedHubUser): PersonObservation {
  const displayName = sanitizePlainText(user.fullname || user.user, 200) || user.user;
  return {
    displayName,
    identities: [
      {
        provider: "hugging-face",
        externalId: user._id,
        username: user.user,
        profileUrl: profileUrl(user.user),
        verified: true,
      },
    ],
    avatarUrl: avatarUrl(user.avatarUrl),
    sourceUrl: profileUrl(user.user),
  };
}

function artifactEvent(
  kind: HubArtifactKind,
  artifact: HubArtifact,
  user: VerifiedHubUser,
  now: Date,
): DiscoveryEvent {
  const id = artifactId(artifact);
  const url = artifactUrl(kind, id);
  const complexity = analyzeHuggingFaceArtifactMetadata(kind, artifact);
  const person = personObservation(user);
  const kindLabel = kind === "space" ? "app" : kind;
  const card = asPlainObject(artifact.cardData);
  const shortDescription = sanitizePlainText(card.short_description, 1_000);
  const indicators = complexity.indicators.length
    ? `Metadata shows ${complexity.indicators.join(", ")}.`
    : undefined;

  return createDiscoveryEvent({
    source: "hugging-face",
    sourceExternalId: `${kind}:${artifact._id}`,
    type: asNumber(artifact.likes) >= 10 ? "project_momentum" : "project_created",
    title: `${person.displayName} published ${artifactName(id)} on Hugging Face`,
    description: [shortDescription || undefined, indicators].filter(Boolean).join(" ") || undefined,
    occurredAt: artifact.lastModified ?? artifact.createdAt,
    sourceUrl: url,
    person,
    metrics: {
      downloads: asNumber(artifact.downloads),
      likes: asNumber(artifact.likes),
      technicalComplexity: complexity.score,
      technicalComplexityConfidence: complexity.confidence,
    },
    tags: [kindLabel, artifact.library_name ?? "", artifact.pipeline_tag ?? "", ...(artifact.tags ?? [])]
      .filter(Boolean)
      .slice(0, 30),
    raw: {
      artifactId: artifact._id,
      artifactKind: kind,
      repositoryId: id,
      revision: sanitizePlainText(artifact.sha, 100) || null,
      fileNames: (artifact.siblings ?? [])
        .map((sibling) => sanitizePlainText(sibling.rfilename, 300))
        .filter(Boolean)
        .slice(0, 80),
      technicalComplexity: complexity,
    },
    confidence: Math.min(0.92, 0.72 + complexity.confidence * 0.2),
    now,
  });
}

async function listArtifacts(
  kind: HubArtifactKind,
  query: string,
  limit: number,
  context: ConnectorRunContext,
) {
  const url = new URL(`${HUB_ORIGIN}/api/${artifactPath(kind)}`);
  url.searchParams.set("search", query);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("sort", "lastModified");
  url.searchParams.set("direction", "-1");
  url.searchParams.set("full", "true");
  const response = await smartFetch(url.toString(), {
    headers: hubHeaders(),
    maxBytes: 2_000_000,
    rateLimitPerSecond: process.env.HF_TOKEN?.trim() ? 3 : 1.5,
    retries: 3,
    signal: context.signal,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} from huggingface.co`);
  const payload = (await response.json()) as unknown;
  return Array.isArray(payload) ? (payload as HubArtifact[]) : [];
}

async function getVerifiedUser(username: string, signal?: AbortSignal) {
  const response = await smartFetch(
    `${HUB_ORIGIN}/api/users/${encodeURIComponent(username)}/overview`,
    {
      headers: hubHeaders(),
      maxBytes: 500_000,
      rateLimitPerSecond: process.env.HF_TOKEN?.trim() ? 3 : 1.5,
      retries: 3,
      signal,
    },
  );
  // Organization namespaces return 404 from the user endpoint. They are not
  // people and must not enter candidate identity resolution.
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`HTTP ${response.status} from huggingface.co`);
  const user = (await response.json()) as HubUserOverview;
  if (user.type !== "user" || !user._id || !user.user) return null;
  return user as VerifiedHubUser;
}

export function selectHuggingFaceQueryIndex(
  queries: readonly string[],
  cursorValue: unknown,
) {
  if (!queries.length) return 0;
  const cursorIndex = Number(cursorValue ?? 0);
  return Number.isSafeInteger(cursorIndex) && cursorIndex >= 0
    ? cursorIndex % queries.length
    : 0;
}

export class HuggingFaceConnector implements DiscoveryConnector {
  readonly kind = "hugging-face" as const;
  readonly displayName = "Hugging Face Hub";

  async discover(context: ConnectorRunContext): Promise<ConnectorRunResult> {
    const configuredQueries = context.settings.queries?.filter(Boolean) ?? [];
    const queries = (configuredQueries.length ? configuredQueries : ["robotics"])
      .slice(0, MAX_QUERIES);
    const queryIndex = selectHuggingFaceQueryIndex(queries, context.cursor?.queryIndex);
    const query = queries[queryIndex];
    const maxItems = Math.min(MAX_ARTIFACTS, Math.max(1, context.settings.maxItems ?? 45));
    const perKind = Math.min(25, Math.max(1, Math.ceil(maxItems / ARTIFACT_KINDS.length)));
    const lookbackDays = Math.min(365, Math.max(1, context.settings.lookbackDays ?? 30));
    const cutoff = context.now.getTime() - lookbackDays * 86_400_000;
    const warnings: string[] = [];

    const batches = await Promise.all(
      ARTIFACT_KINDS.map(async (kind) => {
        try {
          const artifacts = await listArtifacts(kind, query, perKind, context);
          return artifacts
            .filter((artifact) => isPublicHuggingFaceArtifact(kind, artifact))
            .filter((artifact) => {
              const timestamp = Date.parse(artifact.lastModified ?? artifact.createdAt ?? "");
              return Number.isFinite(timestamp) && timestamp >= cutoff;
            })
            .map((artifact) => ({ artifact, kind }));
        } catch (error) {
          warnings.push(
            `Hugging Face ${kind} search failed: ${error instanceof Error ? error.message : "unknown error"}`,
          );
          return [];
        }
      }),
    );
    const artifacts = batches.flat().slice(0, maxItems);
    const authors = [...new Set(artifacts.map(({ artifact }) => artifact.author).filter(Boolean))]
      .slice(0, MAX_PROFILE_LOOKUPS) as string[];
    const profiles = await mapLimit(authors, 3, async (author) => {
      try {
        return [author, await getVerifiedUser(author, context.signal)] as const;
      } catch (error) {
        warnings.push(
          `Hugging Face profile check failed for ${author}: ${error instanceof Error ? error.message : "unknown error"}`,
        );
        return [author, null] as const;
      }
    });
    const users = new Map(
      profiles.filter((entry): entry is readonly [string, VerifiedHubUser] => Boolean(entry[1])),
    );
    const events = artifacts.flatMap(({ artifact, kind }) => {
      const user = artifact.author ? users.get(artifact.author) : undefined;
      return user ? [artifactEvent(kind, artifact, user, context.now)] : [];
    });

    return {
      events: events.slice(0, maxItems),
      cursor: {
        query,
        queryIndex: (queryIndex + 1) % queries.length,
        since: context.now.toISOString(),
      },
      warnings,
    };
  }
}
