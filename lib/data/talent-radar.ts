import "server-only";

import { isIP } from "node:net";

import type {
  Candidate,
  CandidateListOptions,
  CandidateSearchOptions,
  CandidateStatus,
  CriterionProfile,
  CriterionSignal,
  DigestCadence,
  DashboardData,
  DigestSubscriber,
  DiscoverySource,
  EditableManualProfile,
  EditableSourceConfiguration,
  EditableSourceOptions,
  EditableStructuredSourcePage,
  EvidenceLink,
  TalentEvent,
} from "@/lib/domain/types";
import {
  contactRoutesFromIdentities,
  contactRoutesFromJson,
  normalizeContactRoutes,
} from "@/lib/contact/routes";
import { getAdminSupabaseClient, hasSupabaseAdminEnv } from "@/lib/supabase/admin";
import { assertPublicHttpUrl, isBlockedIp, sanitizePlainText } from "@/lib/discovery/security";
import { isLinkedInDirectAccessApproved } from "@/lib/discovery/linkedin-policy";
import type { CandidateRow, CriterionProfileRow, DigestItemRow, DigestRow, DigestSubscriberRow, EventRow, Json, SourceRow } from "@/lib/supabase/database.types";

import type {
  AddIdentityCandidateHypothesisInput,
  ClaimDigestDeliveryResult,
  CreateDigestInput,
  CreateDigestResult,
  CreateIngestionRunInput,
  CriterionProfileVersionInput,
  DataReadiness,
  DigestRecord,
  DigestSubscriberMutation,
  IdentityCandidateMatch,
  IdentityObservationInput,
  IdentityResolutionResult,
  IngestionRunRecord,
  InsertCandidateEventInput,
  MergeCandidateObservationInput,
  MergeCandidateObservationResult,
  RankedCandidate,
  RecordCandidateFeedbackInput,
  ReviewIdentityCandidateInput,
  SourceConfigurationUpdate,
  SourceRecord,
  SubscriberDeliveryUpdate,
  TasteFeedbackRecord,
  UpdateSourceEnabledResult,
  UpdateSourceConfigurationResult,
  UpdateCandidateIntelligenceInput,
  UpdateDigestDeliveryInput,
  UpdateIngestionRunInput,
  UpsertCandidateInput,
  UpsertGraphEdgeInput,
  UpsertGraphNodeInput,
} from "./contracts";

export class DataNotConfiguredError extends Error {
  constructor() {
    super("Unfound data storage is not configured");
    this.name = "DataNotConfiguredError";
  }
}

export class SubscriberDeliveryBlockedError extends Error {
  constructor() {
    super("Resolve the delivery issue before resuming this recipient");
    this.name = "SubscriberDeliveryBlockedError";
  }
}

function workspaceId(value?: string | number) {
  const raw = [
    value,
    process.env.UNFOUND_WORKSPACE_ID,
    process.env.TALENT_RADAR_WORKSPACE_ID,
    process.env.TALENT_WORKSPACE_ID,
  ]
    .map((candidate) => String(candidate ?? "").trim())
    .find(Boolean) ?? "1";
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("Workspace id must be a positive integer");
  return parsed;
}

function db() {
  if (!hasSupabaseAdminEnv()) throw new DataNotConfiguredError();
  return getAdminSupabaseClient();
}

function fail(error: { code?: string; message: string } | null) {
  if (!error) return;
  if (
    error.code === "PGRST205" ||
    /could not find the table ['"]public\.[^'"]+['"] in the schema cache/i.test(error.message)
  ) {
    throw new DataNotConfiguredError();
  }
  throw new Error(error.message);
}

function record(value: Json | unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseDigestCadence(value: unknown): DigestCadence {
  return value === "daily" ||
    value === "twice_weekly" ||
    value === "biweekly"
    ? value
    : "weekly";
}

function parseMinimumScore(value: unknown) {
  const score = Number(value);
  if (score === 62) return 12;
  if (score === 55 || score === 75) return 18;
  if (score === 86) return 28;
  return Number.isFinite(score) ? Math.min(100, Math.max(0, score)) : 18;
}

function observationWindow(
  seenAt: string | undefined,
  existingFirstSeenAt?: unknown,
  existingLastSeenAt?: unknown,
) {
  const now = new Date().toISOString();
  const requested = seenAt ?? now;
  const safeSeenAt = Number.isFinite(new Date(requested).getTime()) ? requested : now;
  const timestamps = [safeSeenAt, existingFirstSeenAt, existingLastSeenAt]
    .map((value) => String(value ?? ""))
    .filter((value) => Number.isFinite(new Date(value).getTime()))
    .sort((left, right) => new Date(left).getTime() - new Date(right).getTime());
  return {
    firstSeenAt: timestamps[0] ?? safeSeenAt,
    lastSeenAt: timestamps.at(-1) ?? safeSeenAt,
  };
}

function normalizedName(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function safeStoredHttpUrl(value: unknown): string | undefined {
  const raw = sanitizePlainText(value, 2_000);
  if (!raw) return undefined;
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return undefined;
    const hostname = url.hostname.replace(/\.$/, "").toLowerCase();
    const ipHostname = hostname.replace(/^\[|\]$/g, "");
    if (
      !hostname ||
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal") ||
      (isIP(ipHostname) > 0 && isBlockedIp(ipHostname))
    ) return undefined;
    url.hostname = hostname;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|ref$)/i.test(key)) url.searchParams.delete(key);
    }
    if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString();
  } catch {
    return undefined;
  }
}

async function publicWebsiteUrl(value: unknown): Promise<string | undefined> {
  const normalized = safeStoredHttpUrl(value);
  if (!normalized) return undefined;
  try {
    return (await assertPublicHttpUrl(normalized)).toString();
  } catch {
    return undefined;
  }
}

function mergeUniqueText(existing: unknown, incoming: string[] | undefined, limit = 50) {
  const values = Array.isArray(existing) ? existing : [];
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const value of [...values, ...(incoming ?? [])]) {
    const cleaned = sanitizePlainText(value, 300);
    const key = normalizedName(cleaned);
    if (!cleaned || !key || seen.has(key)) continue;
    seen.add(key);
    merged.push(cleaned);
    if (merged.length >= limit) break;
  }
  return merged;
}

function mergeObservedNames(
  existing: unknown,
  incoming: MergeCandidateObservationInput["alternateNames"],
  canonicalName: string,
  limit = 20,
) {
  const values = [
    ...(Array.isArray(existing) ? existing : []),
    ...(incoming ?? []),
  ];
  const canonicalKey = normalizedName(canonicalName);
  const strongest = new Map<string, { name: string; sourceUrl: string; confidence: number; proof: string }>();
  for (const value of values) {
    const item = record(value);
    const name = sanitizePlainText(item.name, 200);
    const key = normalizedName(name);
    const sourceUrl = safeStoredHttpUrl(item.sourceUrl);
    const confidence = Math.max(0, Math.min(1, Number(item.confidence ?? 0)));
    const proof = sanitizePlainText(item.proof, 100);
    if (!name || !key || key === canonicalKey || !sourceUrl || confidence < 0.6 || !proof) continue;
    const current = strongest.get(key);
    if (!current || confidence > current.confidence) {
      strongest.set(key, { name, sourceUrl, confidence, proof });
    }
  }
  return [...strongest.values()]
    .sort((left, right) => right.confidence - left.confidence || left.name.localeCompare(right.name))
    .slice(0, limit);
}

function mergeUniqueUrls(existing: unknown, incoming: string[] | undefined, limit = 20) {
  const values = Array.isArray(existing) ? existing : [];
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const value of [...values, ...(incoming ?? [])]) {
    const url = safeStoredHttpUrl(value);
    const key = url?.toLocaleLowerCase("en-US");
    if (!url || !key || seen.has(key)) continue;
    seen.add(key);
    merged.push(url);
    if (merged.length >= limit) break;
  }
  return merged;
}

function redactContactText(value: unknown, maxLength: number) {
  return sanitizePlainText(value, maxLength)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[contact redacted]")
    .replace(/(?:\+?\d[\d\s().-]{7,}\d)/g, "[contact redacted]");
}

function numberRecord(value: Json | unknown) {
  return Object.fromEntries(
    Object.entries(record(value))
      .map(([key, item]) => [key, Number(item)])
      .filter(([, item]) => Number.isFinite(item)),
  ) as Record<string, number>;
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("");
}

function confidenceBand(value: number): "low" | "medium" | "high" {
  return value >= 0.82 ? "high" : value >= 0.58 ? "medium" : "low";
}

const emptyCriterion: CriterionProfile = {
  id: "unconfigured",
  name: "Default criterion",
  version: 1,
  status: "active",
  lookForMarkdown: "",
  avoidMarkdown: "",
  signals: [],
  minimumScore: 25,
  minimumConfidence: 0.6,
  weeklyCandidateCount: 12,
  digestCadence: "weekly",
  digestDaysOfWeek: [1],
  digestDeliveryHourUtc: 15,
  digestDeliveryMinuteUtc: 0,
  digestPreparationLeadHours: 3,
  explorationRate: 0.1,
  learningRate: 0.01,
  lastLearnedAt: null,
  trainingSampleCount: 0,
};

export function getDataReadiness(workspace?: string | number): DataReadiness {
  const storageReady = hasSupabaseAdminEnv();
  return {
    dataMode: storageReady ? "empty" : "unconfigured",
    missingCapabilities: [
      ...(!storageReady ? ["supabase-url", "supabase-service-role-key"] : []),
      ...(!process.env.CRON_SECRET ? ["scheduled-runs"] : []),
    ],
    workspaceId: String(workspaceId(workspace)),
  };
}

type RelatedRows = {
  events: EventRow[];
  identities: Array<Record<string, unknown>>;
  evidence: Array<Record<string, unknown>>;
  graphNodes: Array<Record<string, unknown>>;
  graphEdges: Array<Record<string, unknown>>;
  candidateSlugs: Map<string, string>;
};

function providerLabel(value: unknown) {
  const provider = String(value ?? "Public graph");
  const known: Record<string, string> = {
    github: "GitHub",
    gitlab: "GitLab",
    openalex: "OpenAlex",
    "semantic-scholar": "Semantic Scholar",
    "hugging-face": "Hugging Face",
    codeforces: "Codeforces",
    x: "X",
  };
  return known[provider.toLowerCase()] ?? provider.replace(/[-_]/g, " ");
}

function mapConnections(
  candidateId: number,
  candidateIdentities: Array<Record<string, unknown>>,
  related: RelatedRows,
): Candidate["connections"] {
  const identityIds = new Set(candidateIdentities.map((identity) => String(identity.id)));
  const identityKeys = new Set(
    candidateIdentities.flatMap((identity) =>
      [identity.provider_subject_id, identity.handle, identity.profile_url]
        .filter(Boolean)
        .map((key) => `${String(identity.provider).toLowerCase()}:${String(key).toLowerCase()}`),
    ),
  );
  const candidateNodes = related.graphNodes.filter((node) => {
    if (String(node.candidate_id ?? "") === String(candidateId)) return true;
    if (node.identity_id && identityIds.has(String(node.identity_id))) return true;
    return identityKeys.has(
      `${String(node.provider ?? "").toLowerCase()}:${String(node.external_key ?? "").toLowerCase()}`,
    );
  });
  const candidateNodeIds = new Set(candidateNodes.map((node) => String(node.id)));
  if (!candidateNodeIds.size) return [];

  const nodeById = new Map(related.graphNodes.map((node) => [String(node.id), node]));
  const identityById = new Map(related.identities.map((identity) => [String(identity.id), identity]));
  const identityByProviderKey = new Map<string, Record<string, unknown>>();
  for (const identity of related.identities) {
    for (const key of [identity.provider_subject_id, identity.handle, identity.profile_url]) {
      if (key) {
        identityByProviderKey.set(
          `${String(identity.provider).toLowerCase()}:${String(key).toLowerCase()}`,
          identity,
        );
      }
    }
  }

  const candidateForNode = (node: Record<string, unknown>) => {
    if (node.candidate_id) return String(node.candidate_id);
    if (node.identity_id) {
      const identity = identityById.get(String(node.identity_id));
      if (identity?.candidate_id) return String(identity.candidate_id);
    }
    const identity = identityByProviderKey.get(
      `${String(node.provider ?? "").toLowerCase()}:${String(node.external_key ?? "").toLowerCase()}`,
    );
    return identity?.candidate_id ? String(identity.candidate_id) : undefined;
  };

  const seen = new Set<string>();
  return related.graphEdges
    .filter(
      (edge) =>
        candidateNodeIds.has(String(edge.from_node_id)) ||
        candidateNodeIds.has(String(edge.to_node_id)),
    )
    .sort((left, right) => Number(right.strength ?? 0) - Number(left.strength ?? 0))
    .flatMap((edge) => {
      const fromCandidate = candidateNodeIds.has(String(edge.from_node_id));
      const neighbor = nodeById.get(
        String(fromCandidate ? edge.to_node_id : edge.from_node_id),
      );
      const sourceNode = nodeById.get(
        String(fromCandidate ? edge.from_node_id : edge.to_node_id),
      );
      if (!neighbor) return [];
      const key = `${neighbor.id}:${edge.relationship_type}`;
      if (seen.has(key)) return [];
      seen.add(key);
      const neighborCandidateId = candidateForNode(neighbor);
      return [
        {
          id: String(edge.id),
          name: String(neighbor.label ?? neighbor.external_key ?? "Graph connection"),
          candidateSlug: neighborCandidateId
            ? related.candidateSlugs.get(neighborCandidateId)
            : undefined,
          relationship: String(edge.relationship_type ?? "connected"),
          source: providerLabel(sourceNode?.provider ?? neighbor.provider),
          strength: Math.max(0, Math.min(1, Number(edge.strength ?? 0))),
        },
      ];
    })
    .slice(0, 20);
}

function mapEvent(row: EventRow, evidence: Array<Record<string, unknown>>): TalentEvent {
  const raw = record(row.raw_payload);
  const rawMetrics = record(raw.metrics);
  const complexity = record(raw.technicalComplexity);
  const components = record(complexity.components);
  const componentWeight: Record<string, number> = {
    sourceSurface: 0.2,
    languageBreadth: 0.1,
    testsAndCi: 0.15,
    systemsAndResearch: 0.16,
    authoredCodeRatio: 0.1,
    historyDepth: 0.1,
    contributorShape: 0.06,
    documentationAndBenchmarks: 0.08,
    hardConstraintMatch: 0.02,
    tractionCorroboration: 0.03,
  };
  const reconstructedComplexity = Object.entries(componentWeight).reduce(
    (total, [key, weight]) => total + Math.max(0, Math.min(1, Number(components[key]) || 0)) * weight,
    0,
  ) * (Number(components.hardConstraintMatch) > 0 ? 1 : 0.72);
  const metrics = Object.fromEntries(
    Object.entries(rawMetrics)
      .filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])),
  );
  const technicalComplexity = Number(complexity.score) || reconstructedComplexity;
  if (technicalComplexity > 0) {
    metrics.technicalComplexity = technicalComplexity;
    metrics.technicalComplexityConfidence = Number(complexity.confidence) || 0.72;
  }
  const links = evidence
    .filter((item) => String(item.event_id) === String(row.id))
    .map((item) => ({
      label: String(item.label ?? row.source_label),
      url: String(item.url ?? row.source_url),
      kind: String(item.evidence_kind ?? "primary") as EvidenceLink["kind"],
      excerpt: item.excerpt ? String(item.excerpt) : undefined,
    }));
  return {
    id: String(row.id),
    candidateId: String(row.candidate_id),
    type: row.event_type,
    title: row.title,
    summaryMarkdown: row.summary_md,
    evidenceExcerpt: row.evidence_excerpt ?? undefined,
    whyItMattersMarkdown: row.why_it_matters_md,
    occurredAt: row.occurred_at,
    discoveredAt: row.discovered_at,
    sourceLabel: row.source_label,
    sourceUrl: row.source_url,
    confidence: Number(row.confidence),
    novelty: Number(row.novelty_score),
    significance: Number(row.significance_score),
    metrics,
    tags: Array.isArray(raw.tags)
      ? raw.tags.filter((tag): tag is string => typeof tag === "string").slice(0, 30)
      : [],
    raw,
    links: links.length
      ? links
      : [{ label: row.source_label, url: row.source_url, kind: "primary" }],
  };
}

function mapCandidate(row: CandidateRow, related: RelatedRows): Candidate {
  const attributes = record(row.attributes);
  const events = related.events
    .filter((event) => event.candidate_id === row.id)
    .map((event) => mapEvent(event, related.evidence))
    .sort((a, b) => b.discoveredAt.localeCompare(a.discoveredAt));
  const candidateIdentityRows = related.identities.filter(
    (identity) => String(identity.candidate_id) === String(row.id),
  );
  const identities = candidateIdentityRows
    .map((identity) => ({
      id: String(identity.id),
      provider: String(identity.provider),
      providerSubjectId: String(identity.provider_subject_id ?? identity.id),
      handle: identity.handle ? String(identity.handle) : undefined,
      profileUrl: identity.profile_url ? String(identity.profile_url) : undefined,
      displayName: String(identity.display_name ?? row.canonical_name),
      resolutionStatus: String(identity.resolution_status ?? "unresolved") as Candidate["identities"][number]["resolutionStatus"],
      confidence: Number(identity.match_confidence ?? 0),
      distinguishingFacts: Object.keys(record(identity.distinguishing_facts)),
      ambiguityKey: identity.ambiguity_key ? String(identity.ambiguity_key) : undefined,
    }));
  const websiteUrl = safeStoredHttpUrl(attributes.websiteUrl);
  const biography = sanitizePlainText(attributes.biography, 2_000) || undefined;
  const affiliations = mergeUniqueText(attributes.affiliations, row.school ? [row.school] : []);
  const alternateNames = mergeObservedNames(
    attributes.alternateNames,
    undefined,
    row.canonical_name,
  );
  const contactSafetyContext = [
    row.stage,
    row.school,
    ...events.flatMap((event) => [event.type, event.title, event.sourceLabel]),
  ].filter(Boolean).join(" ");
  const contactRoutes = normalizeContactRoutes(
    [
      ...contactRoutesFromJson(attributes.publicContactRoutes),
      ...contactRoutesFromIdentities(identities, websiteUrl),
    ],
    contactSafetyContext,
  );
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    slug: row.slug,
    name: row.canonical_name,
    initials: initials(row.canonical_name),
    avatarUrl: row.avatar_url ?? undefined,
    websiteUrl,
    headline: row.headline ?? "",
    biography,
    location: row.location ?? "",
    stage: row.stage ?? "",
    school: row.school ?? undefined,
    affiliations,
    domains: row.domains ?? [],
    score: Number(row.score),
    momentum: Number(row.momentum),
    confidence: Number(row.confidence),
    confidenceBand: confidenceBand(Number(row.confidence)),
    status: row.status as CandidateStatus,
    summaryMarkdown: row.summary_md,
    briefPolicyVersion: row.brief_prompt_version,
    whyNowMarkdown: row.why_now_md,
    earlynessMarkdown: row.earlyness_md,
    latestEvent: events[0] ?? null,
    events,
    identities,
    alternateNames,
    contactRoutes,
    connections: mapConnections(row.id, candidateIdentityRows, related),
    sourceCount: row.source_count,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    scoreComponents: numberRecord(row.score_components),
  };
}

async function hydrate(rows: CandidateRow[]): Promise<Candidate[]> {
  if (!rows.length) return [];
  const client = db();
  const ids = rows.map((row) => row.id);
  const [eventsResult, identitiesResult, graphNodesResult, graphEdgesResult] = await Promise.all([
    client.from("events").select("*").in("candidate_id", ids).order("discovered_at", { ascending: false }),
    client.from("identities").select("*").in("candidate_id", ids),
    client
      .from("graph_nodes")
      .select("*")
      .eq("workspace_id", rows[0].workspace_id)
      .order("last_seen_at", { ascending: false })
      .limit(2_500),
    client
      .from("graph_edges")
      .select("*")
      .eq("workspace_id", rows[0].workspace_id)
      .order("strength", { ascending: false })
      .limit(5_000),
  ]);
  fail(eventsResult.error);
  fail(identitiesResult.error);
  fail(graphNodesResult.error);
  fail(graphEdgesResult.error);
  const events = (eventsResult.data ?? []) as EventRow[];
  const eventIds = events.map((event) => event.id);
  const evidenceResult = eventIds.length
    ? await client.from("event_evidence").select("*").in("event_id", eventIds)
    : { data: [], error: null };
  fail(evidenceResult.error);
  const related: RelatedRows = {
    events,
    identities: (identitiesResult.data ?? []) as Array<Record<string, unknown>>,
    evidence: (evidenceResult.data ?? []) as Array<Record<string, unknown>>,
    graphNodes: (graphNodesResult.data ?? []) as Array<Record<string, unknown>>,
    graphEdges: (graphEdgesResult.data ?? []) as Array<Record<string, unknown>>,
    candidateSlugs: new Map(rows.map((row) => [String(row.id), row.slug])),
  };
  return rows.map((row) => mapCandidate(row, related));
}

export async function listCandidates(options: CandidateListOptions = {}, workspace?: string | number) {
  if (!hasSupabaseAdminEnv()) return [];
  let query = db()
    .from("candidates")
    .select("*")
    .eq("workspace_id", workspaceId(workspace))
    .neq("status", "archived")
    .order("score", { ascending: false })
    .order("id", { ascending: false })
    .limit(Math.min(500, options.limit ?? 100));
  if (options.statuses?.length) query = query.in("status", options.statuses);
  if (options.domains?.length) query = query.overlaps("domains", options.domains);
  if (options.cursor) {
    query = query.or(`score.lt.${options.cursor.score},and(score.eq.${options.cursor.score},id.lt.${Number(options.cursor.id)})`);
  }
  const { data, error } = await query;
  fail(error);
  return hydrate((data ?? []) as CandidateRow[]);
}

export async function getCandidateBySlug(slug: string, workspace?: string | number) {
  if (!hasSupabaseAdminEnv()) return null;
  let query = db().from("candidates").select("*").eq("workspace_id", workspaceId(workspace));
  query = /^\d+$/.test(slug) ? query.eq("id", Number(slug)) : query.eq("slug", slug);
  const { data, error } = await query.maybeSingle();
  fail(error);
  return data ? (await hydrate([data as CandidateRow]))[0] ?? null : null;
}

export async function searchCandidates(
  queryText: string,
  options: CandidateSearchOptions = {},
  workspace?: string | number,
) {
  if (!hasSupabaseAdminEnv()) return [];
  const limit = Math.min(100, options.limit ?? 20);
  const hasPostFilters = Boolean(
    options.statuses?.length ||
      options.careerStages?.length ||
      options.eventTypes?.length ||
      options.locations?.length ||
      options.sources?.length,
  );
  const { data, error } = await db().rpc("hybrid_search_candidates", {
    p_workspace_id: workspaceId(workspace),
    p_query_text: queryText,
    p_query_embedding: options.embedding ?? null,
    p_match_count: hasPostFilters ? 100 : limit,
    p_semantic_weight: options.embedding ? (options.semanticWeight ?? 0.65) : 0,
    p_domains: options.domains ?? null,
  });
  fail(error);
  const ranked = (data ?? []) as Array<Record<string, unknown>>;
  const ids = ranked.map((row) => Number(row.id)).filter(Number.isFinite);
  if (!ids.length) return [];
  const candidatesResult = await db().from("candidates").select("*").in("id", ids);
  fail(candidatesResult.error);
  const candidates = await hydrate((candidatesResult.data ?? []) as CandidateRow[]);
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const ordered: Candidate[] = [];
  for (const row of ranked) {
      const candidate = byId.get(String(row.id));
      if (!candidate) continue;
      ordered.push({
        ...candidate,
        scoreComponents: {
          ...candidate.scoreComponents,
          semanticSimilarity: Number(row.semantic_similarity ?? 0),
          textRank: Number(row.text_rank ?? 0),
          combinedScore: Number(row.combined_score ?? 0),
        },
      });
  }
  const normalizedSet = (values: string[] | undefined) =>
    new Set(
      (values ?? [])
        .map((value) => value.trim().toLocaleLowerCase("en-US"))
        .filter(Boolean),
    );
  const statuses = new Set(options.statuses ?? []);
  const stages = normalizedSet(options.careerStages);
  const locations = normalizedSet(options.locations);
  const eventTypes = normalizedSet(options.eventTypes);
  const sources = normalizedSet(options.sources);
  return ordered
    .filter((candidate) => candidate.score >= (options.minimumScore ?? 0))
    .filter((candidate) => !statuses.size || statuses.has(candidate.status))
    .filter(
      (candidate) =>
        !stages.size || stages.has(candidate.stage.trim().toLocaleLowerCase("en-US")),
    )
    .filter(
      (candidate) =>
        !locations.size ||
        locations.has(candidate.location.trim().toLocaleLowerCase("en-US")),
    )
    .filter(
      (candidate) =>
        !eventTypes.size ||
        candidate.events.some((event) =>
          eventTypes.has(event.type.trim().toLocaleLowerCase("en-US")),
        ),
    )
    .filter(
      (candidate) =>
        !sources.size ||
        candidate.events.some((event) =>
          sources.has(event.sourceLabel.trim().toLocaleLowerCase("en-US")),
        ),
    )
    .slice(0, limit);
}

const QUERY_LIMITS = new Map<string, number>([
  ["github", 8],
  ["gitlab", 8],
  ["openalex", 8],
  ["crossref", 8],
  ["arxiv", 8],
  ["semantic-scholar", 8],
  ["hugging-face", 8],
  ["x", 8],
]);

const URL_SOURCE_KINDS = new Set([
  "rss",
  "technical-blogs",
  "project-launches",
  "web-presence",
]);

const STRUCTURED_SOURCE_KINDS = new Set([
  "structured-results",
  "competition-results",
  "science-fairs",
  "hackathons",
]);

const LOOKBACK_SETTINGS = new Map<string, { defaultValue: number; maximum: number }>([
  ["github", { defaultValue: 14, maximum: 90 }],
  ["gitlab", { defaultValue: 14, maximum: 90 }],
  ["openalex", { defaultValue: 21, maximum: 365 }],
  ["crossref", { defaultValue: 21, maximum: 365 }],
  ["hugging-face", { defaultValue: 30, maximum: 365 }],
]);

const MAX_ITEMS_BY_KIND = new Map<string, number>([
  ["github", 100],
  ["gitlab", 100],
  ["openalex", 200],
  ["crossref", 200],
  ["arxiv", 150],
  ["semantic-scholar", 100],
  ["hugging-face", 75],
  ["codeforces", 100],
  ["hacker-news", 100],
  ["rss", 250],
  ["technical-blogs", 250],
  ["project-launches", 250],
  ["structured-results", 500],
  ["competition-results", 500],
  ["science-fairs", 500],
  ["hackathons", 500],
  ["web-presence", 200],
  ["x", 100],
  ["linkedin-manual", 100],
  ["brave-enrichment", 8],
]);

const OPTION_KEYS_BY_KIND = new Map<string, ReadonlySet<keyof EditableSourceOptions>>([
  ["github", new Set(["complexityKeywords"])],
  ["gitlab", new Set(["complexityKeywords"])],
  ["codeforces", new Set(["maxContests"])],
  [
    "hacker-news",
    new Set(["feed", "minimumScore", "topicKeywords", "requireTopicMatch"]),
  ],
  ["brave-enrichment", new Set(["maxQueries", "maxResults"])],
  ["structured-results", new Set(["pages"])],
  ["competition-results", new Set(["pages"])],
  ["science-fairs", new Set(["pages"])],
  ["hackathons", new Set(["pages"])],
  ["linkedin-manual", new Set(["profiles"])],
]);

function cleanOptionalText(value: unknown, maximum: number) {
  if (typeof value !== "string") return undefined;
  return sanitizePlainText(value, maximum) || undefined;
}

function cleanStringArray(value: unknown, limit: number, itemMaximum = 300) {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    const cleaned = cleanOptionalText(candidate, itemMaximum);
    if (!cleaned) continue;
    const key = cleaned.toLocaleLowerCase("en-US");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
    if (result.length >= limit) break;
  }
  return result;
}

function safeEditableConfigUrl(value: unknown) {
  const normalized = safeStoredHttpUrl(value);
  if (!normalized) return undefined;
  const url = new URL(normalized);
  const hostname = url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLocaleLowerCase("en-US");
  const mappedIpv4 = hostname.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (
    (!hostname.includes(".") && isIP(hostname) === 0) ||
    hostname.endsWith(".lan") ||
    hostname.endsWith(".home") ||
    hostname.endsWith(".home.arpa") ||
    (mappedIpv4 && isBlockedIp(mappedIpv4))
  ) {
    return undefined;
  }
  return normalized;
}

function safeSelectorFromStorage(value: unknown) {
  const selector = cleanOptionalText(value, 160);
  if (
    !selector ||
    /[\u0000-\u001f\u007f{};]/u.test(selector) ||
    /:(?:has|contains|matches)\s*\(/iu.test(selector)
  ) {
    return undefined;
  }
  return selector;
}

const STRUCTURED_EVENT_TYPES = new Set([
  "competition_result",
  "hackathon_result",
  "fellowship_or_grant",
  "community_recognition",
]);

function safeStructuredPages(value: unknown): EditableStructuredSourcePage[] {
  if (!Array.isArray(value)) return [];
  const pages: EditableStructuredSourcePage[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    const page = record(candidate);
    const url = safeEditableConfigUrl(page.url);
    const itemSelector = safeSelectorFromStorage(page.itemSelector);
    const nameSelector = safeSelectorFromStorage(page.nameSelector);
    if (!url || !itemSelector || !nameSelector || seen.has(url)) continue;
    seen.add(url);
    const eventType = String(page.eventType ?? "");
    const titleSelector = safeSelectorFromStorage(page.titleSelector);
    const descriptionSelector = safeSelectorFromStorage(page.descriptionSelector);
    const linkSelector = safeSelectorFromStorage(page.linkSelector);
    const dateSelector = safeSelectorFromStorage(page.dateSelector);
    const rankSelector = safeSelectorFromStorage(page.rankSelector);
    const affiliationSelector = safeSelectorFromStorage(page.affiliationSelector);
    const eventName = cleanOptionalText(page.eventName, 200);
    const occurredAt = cleanOptionalText(page.occurredAt, 50);
    pages.push({
      url,
      itemSelector,
      nameSelector,
      ...(titleSelector ? { titleSelector } : {}),
      ...(descriptionSelector ? { descriptionSelector } : {}),
      ...(linkSelector ? { linkSelector } : {}),
      ...(dateSelector ? { dateSelector } : {}),
      ...(rankSelector ? { rankSelector } : {}),
      ...(affiliationSelector ? { affiliationSelector } : {}),
      ...(eventName ? { eventName } : {}),
      ...(occurredAt && Number.isFinite(Date.parse(occurredAt)) ? { occurredAt } : {}),
      ...(STRUCTURED_EVENT_TYPES.has(eventType)
        ? { eventType: eventType as EditableStructuredSourcePage["eventType"] }
        : {}),
    });
    if (pages.length >= 20) break;
  }
  return pages;
}

function safeManualProfiles(value: unknown): EditableManualProfile[] {
  if (!Array.isArray(value)) return [];
  const profiles: EditableManualProfile[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    const profile = record(candidate);
    const name = cleanOptionalText(profile.name, 200);
    const profileUrl = safeEditableConfigUrl(profile.profileUrl);
    if (!name || !profileUrl || seen.has(profileUrl)) continue;
    const profileLocation = new URL(profileUrl);
    const hostname = profileLocation.hostname.toLocaleLowerCase("en-US");
    if (
      profileLocation.protocol !== "https:" ||
      (hostname !== "linkedin.com" && !hostname.endsWith(".linkedin.com")) ||
      !/^\/in\/[^/]+\/?$/u.test(profileLocation.pathname)
    ) {
      continue;
    }
    seen.add(profileUrl);
    const observedAt = cleanOptionalText(profile.observedAt, 50);
    const headline = cleanOptionalText(profile.headline, 500);
    const biography = cleanOptionalText(profile.biography, 2_000);
    const location = cleanOptionalText(profile.location, 300);
    const affiliations = cleanStringArray(profile.affiliations, 20);
    const websiteUrl = safeEditableConfigUrl(profile.websiteUrl);
    const note = cleanOptionalText(profile.note, 2_000);
    const provenanceUrl = safeEditableConfigUrl(profile.provenanceUrl);
    const reviewed = profile.reviewed === true;
    profiles.push({
      name,
      profileUrl,
      ...(headline ? { headline } : {}),
      ...(biography ? { biography } : {}),
      ...(location ? { location } : {}),
      ...(affiliations.length ? { affiliations } : {}),
      ...(websiteUrl ? { websiteUrl } : {}),
      ...(observedAt && Number.isFinite(Date.parse(observedAt)) ? { observedAt } : {}),
      ...(note ? { note } : {}),
      ...(provenanceUrl ? { provenanceUrl } : {}),
      reviewed,
    });
    if (profiles.length >= 100) break;
  }
  return profiles;
}

function finiteInteger(value: unknown, minimum: number, maximum: number) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= minimum && numeric <= maximum
    ? numeric
    : undefined;
}

function safeSourceOptions(kind: string, value: unknown): EditableSourceOptions | undefined {
  const options = record(value);
  if (kind === "github" || kind === "gitlab") {
    return { complexityKeywords: cleanStringArray(options.complexityKeywords, 30, 100) };
  }
  if (kind === "codeforces") {
    return { maxContests: finiteInteger(options.maxContests, 1, 5) ?? 2 };
  }
  if (kind === "hacker-news") {
    const feed = ["newstories", "beststories", "topstories", "showstories"].includes(
      String(options.feed),
    )
      ? (options.feed as NonNullable<EditableSourceOptions["feed"]>)
      : "newstories";
    return {
      feed,
      minimumScore: finiteInteger(options.minimumScore, 0, 10_000) ?? 2,
      topicKeywords: cleanStringArray(options.topicKeywords, 30, 100),
      requireTopicMatch: options.requireTopicMatch === true,
    };
  }
  if (kind === "brave-enrichment") {
    return {
      maxQueries: finiteInteger(options.maxQueries, 1, 5) ?? 5,
      maxResults: finiteInteger(options.maxResults, 1, 12) ?? 8,
    };
  }
  if (STRUCTURED_SOURCE_KINDS.has(kind)) {
    return { pages: safeStructuredPages(options.pages) };
  }
  if (kind === "linkedin-manual") {
    return { profiles: safeManualProfiles(options.profiles) };
  }
  return undefined;
}

function editableSourceConfiguration(row: SourceRow): EditableSourceConfiguration {
  const stored = record(row.discovery_config);
  const maximumItems = MAX_ITEMS_BY_KIND.get(row.kind) ?? 500;
  const configuredItems = finiteInteger(row.max_requests_per_run, 1, maximumItems) ?? maximumItems;
  const config: EditableSourceConfiguration = { maxItems: configuredItems };
  const queryLimit = QUERY_LIMITS.get(row.kind);
  if (queryLimit) config.queries = cleanStringArray(stored.queries, queryLimit, 300);
  if (URL_SOURCE_KINDS.has(row.kind)) {
    config.urls = cleanStringArray(stored.urls, 30, 2_000)
      .map(safeEditableConfigUrl)
      .filter((url): url is string => Boolean(url));
  }
  const lookback = LOOKBACK_SETTINGS.get(row.kind);
  if (lookback) {
    config.lookbackDays =
      finiteInteger(stored.lookbackDays, 1, lookback.maximum) ?? lookback.defaultValue;
  }
  const options = safeSourceOptions(row.kind, stored.options);
  if (options) config.options = options;
  return config;
}

function mapSource(row: SourceRow): DiscoverySource {
  const interval = Math.max(5, Number(row.crawl_interval_minutes));
  return {
    id: String(row.id), key: row.connector_key, name: row.name, kind: row.kind,
    status: row.status as DiscoverySource["status"], enabled: row.enabled,
    trustWeight: Number(row.trust_weight), cadence: interval >= 1440 ? "Daily" : `Every ${interval}m`,
    lastSuccessAt: row.last_success_at, nextRunAt: row.next_run_at,
    discoveredThisWeek: Number(record(row.health_metadata).discoveredThisWeek ?? 0),
    config: editableSourceConfiguration(row),
  };
}

const PUBLIC_SOURCE_KINDS = new Set([
  "github",
  "gitlab",
  "crossref",
  "arxiv",
  "semantic-scholar",
  "hugging-face",
  "codeforces",
  "hacker-news",
]);

const FEED_SOURCE_KINDS = new Set([
  "rss",
  "technical-blogs",
  "project-launches",
]);

function hasConfiguredUrl(value: unknown) {
  if (!Array.isArray(value)) return false;
  return value.some((candidate) => Boolean(safeEditableConfigUrl(candidate)));
}

function hasLinkedInProfile(value: unknown) {
  if (!Array.isArray(value)) return false;
  return value.some((candidate) => {
    const profile = record(candidate);
    const name = typeof profile.name === "string" ? profile.name.trim() : "";
    const profileUrl = safeEditableConfigUrl(profile.profileUrl);
    if (!name || !profileUrl || profile.reviewed !== true) return false;
    const parsed = new URL(profileUrl);
    const hostname = parsed.hostname.toLocaleLowerCase("en-US");
    return (
      parsed.protocol === "https:" &&
      (hostname === "linkedin.com" || hostname.endsWith(".linkedin.com")) &&
      /^\/in\/[^/]+\/?$/u.test(parsed.pathname)
    );
  });
}

function hasStructuredPage(value: unknown) {
  if (!Array.isArray(value)) return false;
  return value.some((candidate) => {
    const page = record(candidate);
    return (
      hasConfiguredUrl([page.url]) &&
      Boolean(safeSelectorFromStorage(page.itemSelector)) &&
      Boolean(safeSelectorFromStorage(page.nameSelector))
    );
  });
}

function sourceSetupRequirement(row: SourceRow) {
  if (row.kind === "hugging-face") {
    return cleanStringArray(record(row.discovery_config).queries, 8, 300).length
      ? null
      : ("hugging_face_queries" as const);
  }
  if (PUBLIC_SOURCE_KINDS.has(row.kind)) return null;
  if (row.kind === "openalex") {
    return process.env.OPENALEX_API_KEY?.trim()
      ? null
      : ("openalex_connection" as const);
  }
  if (row.kind === "x") {
    if (!process.env.X_BEARER_TOKEN?.trim()) return "x_connection" as const;
    if (process.env.X_DATA_USE_APPROVED !== "true") return "x_data_use_approval" as const;
    return cleanStringArray(record(row.discovery_config).queries, 8, 300).length
      ? null
      : ("x_queries" as const);
  }
  if (row.kind === "brave-enrichment") {
    return process.env.BRAVE_SEARCH_API_KEY?.trim()
      ? null
      : ("web_search_connection" as const);
  }
  // Personal-site enrichment can run from a verified website already attached
  // to a candidate; configured seed URLs are optional broad-discovery inputs.
  if (row.kind === "web-presence") return null;

  const configuration = record(row.discovery_config);
  const options = record(configuration.options);
  if (row.kind === "linkedin-manual") {
    return hasLinkedInProfile(options.profiles) || isLinkedInDirectAccessApproved()
      ? null
      : ("linkedin_profiles" as const);
  }
  if (FEED_SOURCE_KINDS.has(row.kind)) {
    return hasConfiguredUrl(configuration.urls) ? null : ("feed_urls" as const);
  }
  if (STRUCTURED_SOURCE_KINDS.has(row.kind)) {
    return hasStructuredPage(options.pages) ? null : ("structured_pages" as const);
  }
  return "unsupported_source" as const;
}

export async function listSources(workspace?: string | number) {
  if (!hasSupabaseAdminEnv()) return [];
  const { data, error } = await db().from("sources").select("*").eq("workspace_id", workspaceId(workspace)).order("name");
  fail(error);
  return ((data ?? []) as SourceRow[]).map(mapSource);
}

function sourceConfigurationError(row: SourceRow, update: SourceConfigurationUpdate) {
  const { kind } = row;
  if (update.queries !== undefined) {
    const limit = QUERY_LIMITS.get(kind);
    if (!limit) return "Search queries are not supported for this source.";
    if (update.queries.length > limit) {
      return `This source supports at most ${limit} search queries.`;
    }
    if (kind === "hugging-face" && update.queries.length === 0) {
      return "Add at least one Hugging Face topic.";
    }
  }
  if (update.urls !== undefined && !URL_SOURCE_KINDS.has(kind)) {
    return "Feed or site URLs are not supported for this source.";
  }
  if (update.lookbackDays !== undefined) {
    const settings = LOOKBACK_SETTINGS.get(kind);
    if (!settings) return "A lookback window is not supported for this source.";
    if (update.lookbackDays > settings.maximum) {
      return `This source supports a lookback window of at most ${settings.maximum} days.`;
    }
  }
  const maximumItems = MAX_ITEMS_BY_KIND.get(kind) ?? 500;
  if (update.maxItems !== undefined && update.maxItems > maximumItems) {
    return `This source supports at most ${maximumItems} items per run.`;
  }
  if (update.options !== undefined) {
    const allowed = OPTION_KEYS_BY_KIND.get(kind);
    if (!allowed) return "Additional options are not supported for this source.";
    const unsupported = Object.keys(update.options).find(
      (key) => !allowed.has(key as keyof EditableSourceOptions),
    );
    if (unsupported) return `${unsupported} is not supported for this source.`;
    const effectiveOptions = {
      ...editableSourceConfiguration(row).options,
      ...update.options,
    };
    if (
      kind === "hacker-news" &&
      effectiveOptions.requireTopicMatch === true &&
      !effectiveOptions.topicKeywords?.length
    ) {
      return "Add at least one Hacker News topic before requiring a topic match.";
    }
  }
  return null;
}

function urlsInConfigurationUpdate(update: SourceConfigurationUpdate) {
  return [
    ...(update.urls ?? []),
    ...(update.options?.pages?.map((page) => page.url) ?? []),
    ...(update.options?.profiles?.flatMap((profile) => [
      profile.profileUrl,
      ...(profile.websiteUrl ? [profile.websiteUrl] : []),
      ...(profile.provenanceUrl ? [profile.provenanceUrl] : []),
    ]) ?? []),
  ];
}

async function validateConfigurationUrls(update: SourceConfigurationUpdate) {
  const byHostname = new Map<string, string>();
  for (const candidate of urlsInConfigurationUpdate(update)) {
    try {
      const url = new URL(candidate);
      byHostname.set(url.hostname.toLocaleLowerCase("en-US"), candidate);
    } catch {
      return false;
    }
  }
  try {
    await Promise.all([...byHostname.values()].map((url) => assertPublicHttpUrl(url)));
    return true;
  } catch {
    return false;
  }
}

function mergeSourceConfiguration(
  row: SourceRow,
  update: SourceConfigurationUpdate,
): EditableSourceConfiguration {
  const merged = { ...editableSourceConfiguration(row) };
  if (update.queries !== undefined) merged.queries = [...update.queries];
  if (update.urls !== undefined) merged.urls = [...update.urls];
  if (update.lookbackDays !== undefined) merged.lookbackDays = update.lookbackDays;
  if (update.maxItems !== undefined) merged.maxItems = update.maxItems;
  if (update.options !== undefined) {
    merged.options = safeSourceOptions(row.kind, {
      ...merged.options,
      ...update.options,
    }) ?? {};
  }
  return merged;
}

export async function updateSourceConfiguration(
  workspace: string | number,
  id: string | number,
  update: SourceConfigurationUpdate,
): Promise<UpdateSourceConfigurationResult> {
  const sourceId = Number(id);
  if (!Number.isSafeInteger(sourceId) || sourceId <= 0) {
    throw new Error("Source id must be a positive integer");
  }

  const client = db();
  const selected = await client
    .from("sources")
    .select("*")
    .eq("workspace_id", workspaceId(workspace))
    .eq("id", sourceId)
    .maybeSingle();
  fail(selected.error);
  if (!selected.data) return { ok: false, reason: "not_found" };

  const row = selected.data as SourceRow;
  const configurationError = sourceConfigurationError(row, update);
  if (configurationError) {
    return { ok: false, reason: "invalid_configuration", message: configurationError };
  }
  if (!(await validateConfigurationUrls(update))) {
    return {
      ok: false,
      reason: "invalid_configuration",
      message: "Every URL must resolve to a public internet address.",
    };
  }

  const configuration = mergeSourceConfiguration(row, update);
  const nextRow: SourceRow = {
    ...row,
    discovery_config: configuration as Json,
    max_requests_per_run: configuration.maxItems ?? row.max_requests_per_run,
  };
  if (row.enabled) {
    const requirement = sourceSetupRequirement(nextRow);
    if (requirement) {
      return { ok: false, reason: "setup_required", requirement };
    }
  }

  const updated = await client
    .from("sources")
    .update({
      discovery_config: configuration as Json,
      max_requests_per_run: nextRow.max_requests_per_run,
    })
    .eq("workspace_id", workspaceId(workspace))
    .eq("id", sourceId)
    .select("*")
    .maybeSingle();
  fail(updated.error);
  if (!updated.data) return { ok: false, reason: "not_found" };
  return { ok: true, source: mapSource(updated.data as SourceRow) };
}

export async function updateSourceEnabled(
  workspace: string | number,
  id: string | number,
  enabled: boolean,
): Promise<UpdateSourceEnabledResult> {
  const sourceId = Number(id);
  if (!Number.isSafeInteger(sourceId) || sourceId <= 0) {
    throw new Error("Source id must be a positive integer");
  }

  const client = db();
  const selected = await client
    .from("sources")
    .select("*")
    .eq("workspace_id", workspaceId(workspace))
    .eq("id", sourceId)
    .maybeSingle();
  fail(selected.error);
  if (!selected.data) return { ok: false, reason: "not_found" };

  const row = selected.data as SourceRow;
  if (enabled) {
    const requirement = sourceSetupRequirement(row);
    if (requirement) {
      return { ok: false, reason: "setup_required", requirement };
    }
  }

  const updated = await client
    .from("sources")
    .update({
      enabled,
      status: enabled ? "active" : "disabled",
    })
    .eq("workspace_id", workspaceId(workspace))
    .eq("id", sourceId)
    .select("*")
    .maybeSingle();
  fail(updated.error);
  if (!updated.data) return { ok: false, reason: "not_found" };
  return { ok: true, source: mapSource(updated.data as SourceRow) };
}

export async function getDueSources(workspace: string | number, limit = 20): Promise<SourceRecord[]> {
  if (!hasSupabaseAdminEnv()) return [];
  const { data, error } = await db().from("sources").select("*")
    .eq("workspace_id", workspaceId(workspace)).eq("enabled", true).eq("status", "active")
    .lte("next_run_at", new Date().toISOString()).order("next_run_at").limit(limit);
  fail(error);
  return ((data ?? []) as SourceRow[]).map((row) => ({
    id: String(row.id), workspaceId: String(row.workspace_id), key: row.connector_key,
    name: row.name, kind: row.kind, baseUrl: row.base_url, trustWeight: Number(row.trust_weight),
    maxRequestsPerRun: row.max_requests_per_run, config: row.discovery_config, nextRunAt: row.next_run_at,
  }));
}

export async function getAllSourceRecords(workspace: string | number, limit = 100): Promise<SourceRecord[]> {
  if (!hasSupabaseAdminEnv()) return [];
  const { data, error } = await db().from("sources").select("*")
    .eq("workspace_id", workspaceId(workspace)).eq("enabled", true).eq("status", "active")
    .order("name").limit(limit);
  fail(error);
  return ((data ?? []) as SourceRow[]).map((row) => ({
    id: String(row.id), workspaceId: String(row.workspace_id), key: row.connector_key,
    name: row.name, kind: row.kind, baseUrl: row.base_url, trustWeight: Number(row.trust_weight),
    maxRequestsPerRun: row.max_requests_per_run, config: row.discovery_config, nextRunAt: row.next_run_at,
  }));
}

export async function createIngestionRun(input: CreateIngestionRunInput): Promise<IngestionRunRecord> {
  const { data, error } = await db().from("ingestion_runs").insert({
    workspace_id: workspaceId(input.workspaceId), source_id: input.sourceId ? Number(input.sourceId) : null,
    parent_run_id: input.parentRunId ? Number(input.parentRunId) : null, run_kind: input.kind ?? "scheduled",
    status: "queued", scheduled_for: input.scheduledFor ?? new Date().toISOString(), cursor: input.cursor ?? {},
  }).select("*").single();
  fail(error);
  const row = data as Record<string, unknown>;
  return { id: String(row.id), workspaceId: String(row.workspace_id), sourceId: row.source_id ? String(row.source_id) : null,
    status: String(row.status) as IngestionRunRecord["status"], kind: String(row.run_kind), scheduledFor: String(row.scheduled_for),
    startedAt: row.started_at ? String(row.started_at) : null, finishedAt: row.finished_at ? String(row.finished_at) : null };
}

export async function updateIngestionRun(id: string | number, workspace: string | number, patch: UpdateIngestionRunInput) {
  const payload: Record<string, unknown> = {};
  const mapping: Record<string, string> = { status:"status", startedAt:"started_at", finishedAt:"finished_at", heartbeatAt:"heartbeat_at",
    discoveredCount:"discovered_count", enrichedCount:"enriched_count", eventCount:"event_count", errorCount:"error_count",
    cursor:"cursor", metrics:"metrics", errorCode:"error_code", errorMessage:"error_message" };
  for (const [key, column] of Object.entries(mapping)) if (key in patch) payload[column] = patch[key as keyof UpdateIngestionRunInput];
  const { error } = await db().from("ingestion_runs").update(payload).eq("workspace_id", workspaceId(workspace)).eq("id", Number(id));
  fail(error);
}

export async function updateSourceCursor(id: string | number, workspace: string | number, cursor: Json, nextRunAt: string) {
  const { error } = await db().from("sources").update({ health_metadata: { cursor }, next_run_at: nextRunAt, last_success_at: new Date().toISOString(), status: "active" })
    .eq("workspace_id", workspaceId(workspace)).eq("id", Number(id));
  fail(error);
}

export async function upsertCandidate(input: UpsertCandidateInput) {
  const client = db();
  const wid = workspaceId(input.workspaceId);
  const existing = await client
    .from("candidates")
    .select("first_seen_at,last_seen_at")
    .eq("workspace_id", wid)
    .eq("slug", input.slug)
    .maybeSingle();
  fail(existing.error);
  const window = observationWindow(
    input.lastSeenAt,
    existing.data?.first_seen_at,
    existing.data?.last_seen_at,
  );
  const payload = {
    workspace_id: wid, slug: input.slug, canonical_name: input.name,
    sort_name: input.sortName ?? input.name, headline: input.headline, location: input.location, stage: input.stage,
    school: input.school, avatar_url: input.avatarUrl, domains: input.domains, status: input.status,
    score: input.score, momentum: input.momentum, confidence: input.confidence, summary_md: input.summaryMarkdown,
    why_now_md: input.whyNowMarkdown, earlyness_md: input.earlynessMarkdown, attributes: input.attributes,
    search_text: input.searchText, first_seen_at: window.firstSeenAt, last_seen_at: window.lastSeenAt,
  };
  const { data, error } = await client.from("candidates").upsert(payload, { onConflict: "workspace_id,slug" }).select("id").single();
  fail(error);
  return String((data as Record<string, unknown>).id);
}

/**
 * Merge trusted provider-profile fields into an existing candidate.
 *
 * The provider identity must already be resolved to this candidate. Existing
 * operator-facing fields win, except that a provider handle (or an explicitly
 * replaceable automated name) may be upgraded to the verified display name.
 */
export async function mergeCandidateObservation(
  input: MergeCandidateObservationInput,
): Promise<MergeCandidateObservationResult> {
  const client = db();
  const wid = workspaceId(input.workspaceId);
  const candidateId = Number(input.candidateId);
  if (!Number.isSafeInteger(candidateId) || candidateId <= 0) {
    throw new Error("Candidate id must be a positive integer");
  }

  const provider = sanitizePlainText(input.provider, 100).toLowerCase();
  const providerSubjectId = sanitizePlainText(input.providerSubjectId, 500);
  if (!provider || !providerSubjectId) {
    throw new Error("A provider and provider subject id are required");
  }

  const [candidateResult, identitiesResult] = await Promise.all([
    client
      .from("candidates")
      .select("id,canonical_name,sort_name,headline,location,stage,avatar_url,attributes,last_seen_at")
      .eq("workspace_id", wid)
      .eq("id", candidateId)
      .maybeSingle(),
    client
      .from("identities")
      .select("id,candidate_id,provider,provider_subject_id,handle,profile_url,resolution_status")
      .eq("workspace_id", wid)
      .eq("candidate_id", candidateId),
  ]);
  fail(candidateResult.error);
  fail(identitiesResult.error);
  if (!candidateResult.data) throw new Error("Candidate not found");

  const row = candidateResult.data as Record<string, unknown>;
  const identities = (identitiesResult.data ?? []) as Array<Record<string, unknown>>;
  const linkedProviderIdentity = identities.find(
    (identity) =>
      String(identity.provider).toLowerCase() === provider &&
      String(identity.provider_subject_id ?? "") === providerSubjectId &&
      String(identity.resolution_status) === "resolved",
  );
  if (!input.providerVerified || !linkedProviderIdentity) {
    return { candidateUpdated: false, nameUpdated: false, websiteStored: false };
  }

  const observedAt = (() => {
    const value = new Date(input.seenAt ?? Date.now());
    return Number.isNaN(value.getTime()) ? new Date().toISOString() : value.toISOString();
  })();
  const currentName = sanitizePlainText(row.canonical_name, 200);
  const proposedName = sanitizePlainText(input.displayName, 200);
  const currentNameKey = normalizedName(currentName);
  const proposedNameKey = normalizedName(proposedName);
  const attributes = record(row.attributes);
  const existingNameProvenance = record(attributes.nameProvenance);
  const provenanceKind = String(existingNameProvenance.kind ?? "").toLowerCase();
  const manuallyCorrected =
    attributes.nameCorrectedManually === true ||
    existingNameProvenance.manual === true ||
    provenanceKind === "manual" ||
    provenanceKind === "operator" ||
    provenanceKind === "human-correction";
  const knownHandles = [
    input.providerHandle,
    ...identities.map((identity) => identity.handle),
  ]
    .map((handle) => normalizedName(sanitizePlainText(handle, 200)))
    .filter(Boolean);
  const existingNameIsProviderHandle = knownHandles.includes(currentNameKey);
  const nameMarkedAutomated = existingNameProvenance.automated === true;
  const validReplacementName =
    proposedName.length >= 2 &&
    proposedNameKey.length >= 2 &&
    !/^https?:\/\//i.test(proposedName) &&
    !proposedName.includes("@");
  const nameUpdated = Boolean(
    validReplacementName &&
      proposedNameKey !== currentNameKey &&
      !manuallyCorrected &&
      (existingNameIsProviderHandle || nameMarkedAutomated),
  );

  let websiteStored = false;
  let websiteConflictCandidateId: string | undefined;
  const websiteUrl = await publicWebsiteUrl(input.websiteUrl);
  if (websiteUrl) {
    let websiteIdentityResult = await client
      .from("identities")
      .select("id,candidate_id,display_name,normalized_name,evidence,distinguishing_facts,match_confidence,first_seen_at,last_seen_at")
      .eq("workspace_id", wid)
      .eq("provider", "website")
      .eq("provider_subject_id", websiteUrl)
      .maybeSingle();
    fail(websiteIdentityResult.error);
    if (!websiteIdentityResult.data) {
      websiteIdentityResult = await client
        .from("identities")
        .select("id,candidate_id,display_name,normalized_name,evidence,distinguishing_facts,match_confidence,first_seen_at,last_seen_at")
        .eq("workspace_id", wid)
        .eq("provider", "website")
        .eq("profile_url", websiteUrl)
        .maybeSingle();
      fail(websiteIdentityResult.error);
    }
    const existingWebsiteIdentity = websiteIdentityResult.data as Record<string, unknown> | null;
    if (
      existingWebsiteIdentity?.candidate_id &&
      String(existingWebsiteIdentity.candidate_id) !== String(candidateId)
    ) {
      websiteConflictCandidateId = String(existingWebsiteIdentity.candidate_id);
    } else {
      const sourceUrl =
        safeStoredHttpUrl(input.sourceUrl) ??
        safeStoredHttpUrl(input.providerProfileUrl) ??
        String(linkedProviderIdentity.profile_url ?? websiteUrl);
      const evidenceItem = {
        sourceUrl,
        observedWebsiteUrl: websiteUrl,
        provider,
        providerSubjectId,
        observedAt,
        provenance: "verified-provider-profile",
      };
      const existingEvidence = Array.isArray(existingWebsiteIdentity?.evidence)
        ? existingWebsiteIdentity.evidence
        : [];
      const evidence = [
        ...existingEvidence.filter(
          (item) =>
            !item ||
            typeof item !== "object" ||
            String((item as Record<string, unknown>).sourceUrl ?? "") !== sourceUrl,
        ),
        evidenceItem,
      ].slice(-20);
      const distinguishingFacts = {
        ...record(existingWebsiteIdentity?.distinguishing_facts),
        sourceProvider: provider,
        providerProfileUrl: safeStoredHttpUrl(input.providerProfileUrl),
      };
      const websiteDisplayName =
        sanitizePlainText(existingWebsiteIdentity?.display_name, 200) || proposedName || currentName;
      const websiteNormalizedName =
        sanitizePlainText(existingWebsiteIdentity?.normalized_name, 200) ||
        normalizedName(websiteDisplayName);
      const websiteWindow = observationWindow(
        observedAt,
        existingWebsiteIdentity?.first_seen_at,
        existingWebsiteIdentity?.last_seen_at,
      );
      const websiteIdentityPayload = {
        workspace_id: wid,
        candidate_id: candidateId,
        provider: "website",
        provider_subject_id: websiteUrl,
        profile_url: websiteUrl,
        display_name: websiteDisplayName,
        normalized_name: websiteNormalizedName,
        resolution_status: "resolved",
        match_confidence: Math.max(
          0.97,
          Number(existingWebsiteIdentity?.match_confidence ?? 0),
        ),
        match_method: `verified-${provider}-profile-website`,
        distinguishing_facts: distinguishingFacts,
        evidence,
        first_seen_at: websiteWindow.firstSeenAt,
        last_seen_at: websiteWindow.lastSeenAt,
      };
      const websiteWrite = existingWebsiteIdentity?.id
        ? await client
            .from("identities")
            .update(websiteIdentityPayload)
            .eq("workspace_id", wid)
            .eq("id", Number(existingWebsiteIdentity.id))
        : await client.from("identities").insert(websiteIdentityPayload);
      fail(websiteWrite.error);
      websiteStored = true;
    }
  }

  const nextAttributes: Record<string, unknown> = { ...attributes };
  const affiliations = mergeUniqueText(attributes.affiliations, input.affiliations);
  if (affiliations.length) nextAttributes.affiliations = affiliations;
  const alternateNames = mergeObservedNames(
    attributes.alternateNames,
    input.alternateNames,
    nameUpdated ? proposedName : currentName,
  );
  if (alternateNames.length) nextAttributes.alternateNames = alternateNames;
  const verifiedWebsiteOrigins = new Set(
    identities
      .filter(
        (identity) =>
          String(identity.provider) === "website" &&
          String(identity.resolution_status) === "resolved",
      )
      .flatMap((identity) => {
        const url = safeStoredHttpUrl(identity.profile_url);
        return url ? [new URL(url).origin] : [];
      }),
  );
  if (websiteUrl) verifiedWebsiteOrigins.add(new URL(websiteUrl).origin);
  const observedContactRoutes = normalizeContactRoutes(
    input.contactRoutes ?? [],
    String(row.stage ?? ""),
  ).filter((route) => {
    if (route.audience !== "direct" && route.kind !== "institutional") return true;
    return verifiedWebsiteOrigins.has(new URL(route.provenanceUrl).origin);
  });
  const contactRoutes = normalizeContactRoutes(
    [
      ...contactRoutesFromJson(attributes.publicContactRoutes),
      ...observedContactRoutes,
    ],
    String(row.stage ?? ""),
  );
  if (contactRoutes.length) nextAttributes.publicContactRoutes = contactRoutes;
  const biography = redactContactText(input.biography, 2_000);
  if (biography && !sanitizePlainText(attributes.biography, 2_000)) {
    nextAttributes.biography = biography;
  }
  const providerObservations = record(attributes.providerObservations);
  nextAttributes.providerObservations = {
    ...providerObservations,
    [provider]: {
      ...record(providerObservations[provider]),
      providerSubjectId,
      handle: sanitizePlainText(input.providerHandle, 200) || undefined,
      profileUrl: safeStoredHttpUrl(input.providerProfileUrl),
      sourceUrl: safeStoredHttpUrl(input.sourceUrl),
      verified: true,
      lastObservedAt: observedAt,
    },
  };
  if (websiteStored && websiteUrl) {
    const existingWebsite = safeStoredHttpUrl(attributes.websiteUrl);
    nextAttributes.websiteUrl = existingWebsite ?? websiteUrl;
    nextAttributes.websiteUrls = mergeUniqueUrls(attributes.websiteUrls, [websiteUrl]);
    if (!existingWebsite || existingWebsite === websiteUrl) {
      nextAttributes.websiteProvenance = {
        ...record(attributes.websiteProvenance),
        provider,
        providerSubjectId,
        sourceUrl: safeStoredHttpUrl(input.sourceUrl),
        observedAt,
        verified: true,
      };
    }
  }
  if (nameUpdated) {
    const history = Array.isArray(attributes.nameProvenanceHistory)
      ? attributes.nameProvenanceHistory.slice(-19)
      : [];
    nextAttributes.nameProvenanceHistory = [
      ...history,
      Object.keys(existingNameProvenance).length
        ? existingNameProvenance
        : { name: currentName, kind: existingNameIsProviderHandle ? "provider-handle" : "unknown" },
    ];
    nextAttributes.nameProvenance = {
      name: proposedName,
      previousName: currentName,
      kind: "verified-provider-profile",
      automated: false,
      provider,
      providerSubjectId,
      sourceUrl: safeStoredHttpUrl(input.sourceUrl),
      observedAt,
    };
  } else if (!Object.keys(existingNameProvenance).length) {
    nextAttributes.nameProvenance = {
      name: currentName,
      kind: existingNameIsProviderHandle ? "provider-handle" : "source-observation",
      automated: existingNameIsProviderHandle,
      provider,
      providerSubjectId,
      sourceUrl: safeStoredHttpUrl(input.sourceUrl),
      observedAt,
    };
  }

  const payload: Record<string, unknown> = {
    attributes: nextAttributes,
    last_seen_at:
      new Date(observedAt).getTime() > new Date(String(row.last_seen_at)).getTime()
        ? observedAt
        : row.last_seen_at,
  };
  const headline = redactContactText(input.headline, 500);
  const location = sanitizePlainText(input.location, 300);
  const avatarUrl = safeStoredHttpUrl(input.avatarUrl);
  if (!sanitizePlainText(row.headline, 500) && headline) payload.headline = headline;
  if (!sanitizePlainText(row.location, 300) && location) payload.location = location;
  if (!safeStoredHttpUrl(row.avatar_url) && avatarUrl) payload.avatar_url = avatarUrl;
  if (nameUpdated) {
    payload.canonical_name = proposedName;
    payload.sort_name = proposedName;
  }
  const { error } = await client
    .from("candidates")
    .update(payload)
    .eq("workspace_id", wid)
    .eq("id", candidateId);
  fail(error);
  return {
    candidateUpdated: true,
    nameUpdated,
    websiteStored,
    websiteConflictCandidateId,
  };
}

export async function upsertIdentityObservation(input: IdentityObservationInput): Promise<IdentityResolutionResult> {
  const client = db();
  const wid = workspaceId(input.workspaceId);
  const baseLookup = () => client.from("identities").select("*").eq("workspace_id", wid).eq("provider", input.provider);
  let existing = input.providerSubjectId
    ? await baseLookup().eq("provider_subject_id", input.providerSubjectId).maybeSingle()
    : await baseLookup().eq("profile_url", input.profileUrl ?? "").maybeSingle();
  fail(existing.error);
  if (!existing.data && input.profileUrl) {
    existing = await baseLookup().eq("profile_url", input.profileUrl).maybeSingle();
    fail(existing.error);
  }
  const sameName = await client.from("identities").select("candidate_id,match_confidence").eq("workspace_id", wid)
    .eq("normalized_name", input.normalizedName).not("candidate_id", "is", null).limit(10); fail(sameName.error);
  const existingRow = existing.data as Record<string, unknown> | null;
  const existingCandidateId = existingRow?.candidate_id
    ? String(existingRow.candidate_id)
    : null;
  const candidateIds = [...new Set([
    ...(existingCandidateId ? [existingCandidateId] : []),
    ...(sameName.data ?? []).map((row) => String((row as Record<string, unknown>).candidate_id)),
  ])];
  const candidateRows = candidateIds.length ? await client.from("candidates").select("id,canonical_name,slug").in("id", candidateIds.map(Number)) : { data: [], error: null };
  fail(candidateRows.error);
  const matches: IdentityCandidateMatch[] = ((candidateRows.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    candidateId: String(row.id), name: String(row.canonical_name), slug: String(row.slug),
    score: existingCandidateId === String(row.id) ? 1 : 0.58,
    signals: {}, exactProviderMatch: existingCandidateId === String(row.id),
  }));
  // A durable provider identity is immutable across candidates. Cross-source
  // observations may propose a hypothesis, but they never rewrite an existing
  // binding or replace its provider-authored display fields.
  if (existingRow && existingCandidateId) {
    return {
      identityId: String(existingRow.id),
      status: String(existingRow.resolution_status) as IdentityResolutionResult["status"],
      candidateId: existingCandidateId,
      matches,
    };
  }
  const storedProviderSubjectId = existingRow?.provider_subject_id
    ? String(existingRow.provider_subject_id)
    : null;
  if (
    storedProviderSubjectId &&
    input.providerSubjectId &&
    storedProviderSubjectId !== input.providerSubjectId
  ) {
    return {
      identityId: String(existingRow?.id),
      status: "ambiguous",
      candidateId: null,
      matches,
    };
  }
  const status = input.candidateId ? "resolved" : matches.length ? "ambiguous" : "unresolved";
  const window = observationWindow(
    input.seenAt,
    existingRow?.first_seen_at,
    existingRow?.last_seen_at,
  );
  const payload = { workspace_id: wid, candidate_id: input.candidateId ? Number(input.candidateId) : existing.data && (existing.data as Record<string, unknown>).candidate_id ? Number((existing.data as Record<string, unknown>).candidate_id) : null,
    provider: input.provider, provider_subject_id: storedProviderSubjectId ?? input.providerSubjectId, handle: input.handle, profile_url: input.profileUrl,
    display_name: input.displayName, normalized_name: input.normalizedName, resolution_status: input.candidateId ? "resolved" : status,
    ambiguity_key: input.ambiguityKey, match_confidence: input.confidence ?? 0.5, match_method: input.matchMethod,
    distinguishing_facts: input.distinguishingFacts ?? {}, evidence: input.evidence ?? [], first_seen_at: window.firstSeenAt, last_seen_at: window.lastSeenAt };
  const result = existing.data
    ? await client.from("identities").update(payload).eq("id", Number((existing.data as Record<string, unknown>).id)).select("id,candidate_id,resolution_status").single()
    : await client.from("identities").insert(payload).select("id,candidate_id,resolution_status").single();
  fail(result.error);
  const row = result.data as Record<string, unknown>;
  return { identityId: String(row.id), status: String(row.resolution_status) as IdentityResolutionResult["status"],
    candidateId: row.candidate_id ? String(row.candidate_id) : null, matches };
}

export async function addIdentityCandidateHypothesis(input: AddIdentityCandidateHypothesisInput) {
  const { error } = await db().from("identity_candidates").upsert({ workspace_id: workspaceId(input.workspaceId), identity_id: Number(input.identityId),
    candidate_id: Number(input.candidateId), match_score: input.score, signals: input.signals ?? {}, decision: "proposed" },
    { onConflict: "identity_id,candidate_id" }); fail(error);
}

export async function reviewIdentityCandidate(input: ReviewIdentityCandidateInput) {
  const client = db(); const now = new Date().toISOString();
  const { error } = await client.from("identity_candidates").update({ decision: input.decision, reviewed_by: input.reviewerUserId,
    reviewed_at: now }).eq("workspace_id", workspaceId(input.workspaceId)).eq("identity_id", Number(input.identityId)).eq("candidate_id", Number(input.candidateId)); fail(error);
  if (input.decision === "accepted") { const result = await client.from("identities").update({ candidate_id: Number(input.candidateId), resolution_status: "resolved" })
    .eq("workspace_id", workspaceId(input.workspaceId)).eq("id", Number(input.identityId)); fail(result.error); }
}

export async function insertCandidateEvent(input: InsertCandidateEventInput) {
  const client = db(); const wid = workspaceId(input.workspaceId);
  const existing = await client.from("events").select("id").eq("workspace_id", wid).eq("content_hash", input.contentHash).maybeSingle(); fail(existing.error);
  if (existing.data) {
    const eventId = String((existing.data as Record<string, unknown>).id);
    const result = await client.from("events").update({
      title: input.title,
      occurred_at: input.occurredAt,
      source_url: input.sourceUrl,
      source_label: input.sourceLabel,
      external_id: input.externalId,
      evidence_excerpt: input.evidenceExcerpt,
      confidence: input.confidence,
      raw_payload: input.rawPayload ?? {},
    } as never).eq("workspace_id", wid).eq("id", Number(eventId));
    fail(result.error);
    return { eventId, inserted: false };
  }
  const { data, error } = await client.from("events").insert({ workspace_id: wid, candidate_id: Number(input.candidateId), source_id: input.sourceId ? Number(input.sourceId) : null,
    run_id: input.runId ? Number(input.runId) : null, event_type: input.eventType, title: input.title, summary_md: input.summaryMarkdown ?? "",
    why_it_matters_md: input.whyItMattersMarkdown ?? "", occurred_at: input.occurredAt, discovered_at: input.discoveredAt,
    source_url: input.sourceUrl, source_label: input.sourceLabel, external_id: input.externalId, content_hash: input.contentHash,
    evidence_excerpt: input.evidenceExcerpt, confidence: input.confidence, novelty_score: input.novelty, significance_score: input.significance,
    raw_payload: input.rawPayload ?? {}, llm_model: input.llmModel, prompt_version: input.promptVersion,
    embedding: input.embedding, embedding_model: input.embeddingModel, embedding_updated_at: input.embedding ? new Date().toISOString() : null } as never).select("id").single(); fail(error);
  const eventId = String((data as Record<string, unknown>).id);
  if (input.evidenceLinks?.length) { const result = await client.from("event_evidence").upsert(input.evidenceLinks.map((link) => ({ workspace_id: wid, event_id: Number(eventId),
    url: link.url, label: link.label, excerpt: link.excerpt, evidence_kind: link.kind })), { onConflict: "workspace_id,event_id,url" }); fail(result.error); }
  return { eventId, inserted: true };
}

export async function upsertGraphNode(input: UpsertGraphNodeInput) {
  const client = db(); const wid = workspaceId(input.workspaceId);
  const existing = await client.from("graph_nodes").select("id,candidate_id,identity_id,first_seen_at,last_seen_at").eq("workspace_id", wid).eq("provider", input.provider).eq("external_key", input.externalKey).maybeSingle(); fail(existing.error);
  const window = observationWindow(
    input.seenAt,
    existing.data?.first_seen_at,
    existing.data?.last_seen_at,
  );
  const payload = { workspace_id: wid, candidate_id: input.candidateId ? Number(input.candidateId) : input.identityId ? null : existing.data?.candidate_id ?? null, identity_id: input.identityId ? Number(input.identityId) : input.candidateId ? null : existing.data?.identity_id ?? null,
    node_type: input.nodeType, provider: input.provider, external_key: input.externalKey, label: input.label, url: input.url,
    properties: input.properties ?? {}, first_seen_at: window.firstSeenAt, last_seen_at: window.lastSeenAt };
  const result = existing.data ? await client.from("graph_nodes").update(payload).eq("id", Number((existing.data as Record<string, unknown>).id)).select("id").single()
    : await client.from("graph_nodes").insert(payload).select("id").single(); fail(result.error); return String((result.data as Record<string, unknown>).id);
}

export async function upsertGraphEdge(input: UpsertGraphEdgeInput) {
  const client = db(); const wid = workspaceId(input.workspaceId); const sourceId = input.sourceId ? Number(input.sourceId) : null;
  let lookup = client.from("graph_edges").select("id,evidence_count,first_observed_at,last_observed_at").eq("workspace_id", wid).eq("from_node_id", Number(input.fromNodeId))
    .eq("to_node_id", Number(input.toNodeId)).eq("relationship_type", input.relationshipType);
  lookup = sourceId ? lookup.eq("source_id", sourceId) : lookup.is("source_id", null);
  const existing = await lookup.maybeSingle(); fail(existing.error);
  const observedAt = input.observedAt ?? new Date().toISOString();
  const window = observationWindow(
    observedAt,
    existing.data?.first_observed_at,
    existing.data?.last_observed_at,
  );
  const payload = { workspace_id: wid, from_node_id: Number(input.fromNodeId), to_node_id: Number(input.toNodeId), source_id: sourceId,
    relationship_type: input.relationshipType, directed: input.directed ?? true, strength: input.strength ?? 0.5,
    evidence_count: existing.data ? Number((existing.data as Record<string, unknown>).evidence_count ?? 0) + (input.evidenceCount ?? 1) : input.evidenceCount ?? 1,
    first_observed_at: window.firstSeenAt, last_observed_at: window.lastSeenAt, metadata: input.metadata ?? {} };
  const result = existing.data ? await client.from("graph_edges").update(payload).eq("id", Number((existing.data as Record<string, unknown>).id)).select("id").single()
    : await client.from("graph_edges").insert(payload).select("id").single(); fail(result.error); return String((result.data as Record<string, unknown>).id);
}

export async function updateCandidateIntelligence(input: UpdateCandidateIntelligenceInput) {
  const payload: Record<string, unknown> = {}; const map: Record<string,string> = { score:"score", momentum:"momentum", confidence:"confidence", status:"status",
    summaryMarkdown:"summary_md", whyNowMarkdown:"why_now_md", earlynessMarkdown:"earlyness_md", scoreComponents:"score_components", searchText:"search_text",
    embedding:"embedding", embeddingModel:"embedding_model", sourceCount:"source_count", lastSeenAt:"last_seen_at",
    briefEvidenceFingerprint:"brief_evidence_fingerprint", briefGeneratedAt:"brief_generated_at", briefModel:"brief_model", briefPromptVersion:"brief_prompt_version", briefClaimedUntil:"brief_claimed_until" };
  for (const [key,column] of Object.entries(map)) if (key in input) payload[column] = input[key as keyof UpdateCandidateIntelligenceInput];
  if (input.embedding) payload.embedding_updated_at = new Date().toISOString();
  let lastError: { message: string; code?: string } | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { error } = await db()
      .from("candidates")
      .update(payload)
      .eq("workspace_id", workspaceId(input.workspaceId))
      .eq("id", Number(input.candidateId));
    if (!error) return;
    lastError = error;
    const transient = /fetch failed|timeout|connection|502|503|504/i.test(error.message);
    if (!transient || attempt === 2) break;
    await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
  }
  fail(lastError);
}

export async function listAutomaticReviewShortlist(workspace: string | number, limit = 20) {
  if (!hasSupabaseAdminEnv()) return [];
  const boundedLimit = Math.min(100, Math.max(0, Math.floor(limit)));
  if (!boundedLimit) return [];
  const wid = workspaceId(workspace);
  const backlog = await db()
    .from("candidates")
    .select("*")
    .eq("workspace_id", wid)
    .neq("status", "archived")
    .filter("score_components", "eq", "{}")
    .order("first_seen_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(boundedLimit);
  fail(backlog.error);
  const pending = await hydrate((backlog.data ?? []) as CandidateRow[]);
  if (pending.length >= boundedLimit) return pending;

  const existing = new Set(pending.map((candidate) => candidate.id));
  const ranked = await listCandidates({ limit: boundedLimit }, workspace);
  return [
    ...pending,
    ...ranked.filter((candidate) => !existing.has(candidate.id)),
  ].slice(0, boundedLimit);
}

export async function listEnrichmentShortlist(workspace: string | number, limit = 20) {
  if (!hasSupabaseAdminEnv()) return [];
  const boundedLimit = Math.min(100, Math.max(0, Math.floor(limit)));
  if (!boundedLimit) return [];
  const wid = workspaceId(workspace);
  const claim = await db().rpc("claim_candidate_enrichment_batch", {
    p_workspace_id: wid,
    p_match_count: boundedLimit,
    p_claim_seconds: 360,
  });
  fail(claim.error);
  const rows = claim.data ?? [];
  const ids = rows.map((row) => Number(row.candidate_id)).filter(Number.isFinite);
  if (!ids.length) return [];
  const result = await db().from("candidates").select("*").in("id", ids);
  fail(result.error);
  const candidates = await hydrate((result.data ?? []) as CandidateRow[]);
  const hypothesesResult = await db()
    .from("identity_candidates")
    .select("candidate_id,identity_id,match_score")
    .eq("workspace_id", wid)
    .eq("decision", "proposed")
    .in("candidate_id", ids)
    .gte("match_score", 0.58);
  fail(hypothesesResult.error);
  const hypothesisRows = (hypothesesResult.data ?? []) as Array<Record<string, unknown>>;
  const hypothesisIdentityIds = [
    ...new Set(hypothesisRows.map((row) => Number(row.identity_id)).filter(Number.isFinite)),
  ];
  const hypothesisIdentitiesResult = hypothesisIdentityIds.length
    ? await db().from("identities").select("*").in("id", hypothesisIdentityIds)
    : { data: [], error: null };
  fail(hypothesisIdentitiesResult.error);
  const hypothesisIdentityById = new Map(
    ((hypothesisIdentitiesResult.data ?? []) as Array<Record<string, unknown>>)
      .map((identity) => [String(identity.id), identity]),
  );
  const candidatesWithResearchHypotheses = candidates.map((candidate) => {
    const existing = new Set(
      candidate.identities.map((identity) =>
        `${identity.provider}:${identity.handle || identity.profileUrl || identity.id}`.toLowerCase(),
      ),
    );
    const researchIdentities = hypothesisRows.flatMap((hypothesis) => {
      if (String(hypothesis.candidate_id) !== candidate.id) return [];
      const identity = hypothesisIdentityById.get(String(hypothesis.identity_id));
      if (!identity) return [];
      const key = `${identity.provider}:${identity.handle || identity.profile_url || identity.id}`.toLowerCase();
      if (existing.has(key)) return [];
      existing.add(key);
      return [{
        id: String(identity.id),
        provider: String(identity.provider),
        providerSubjectId: String(identity.provider_subject_id ?? identity.id),
        handle: identity.handle ? String(identity.handle) : undefined,
        profileUrl: identity.profile_url ? String(identity.profile_url) : undefined,
        displayName: String(identity.display_name ?? candidate.name),
        resolutionStatus: "unresolved" as const,
        confidence: Math.min(
          Number(hypothesis.match_score ?? 0.58),
          Number(identity.match_confidence ?? 0.58),
        ),
        distinguishingFacts: Object.keys(record(identity.distinguishing_facts)),
      }];
    });
    return researchIdentities.length
      ? { ...candidate, identities: [...candidate.identities, ...researchIdentities].slice(0, 16) }
      : candidate;
  });
  const byId = new Map(candidatesWithResearchHypotheses.map((candidate) => [candidate.id, candidate]));
  return rows.flatMap((row) => {
    const candidate = byId.get(String(row.candidate_id));
    return candidate ? [{
      candidate,
      researchPass: Number(row.research_pass ?? 0),
      researchRevision: Number(row.research_revision ?? 0),
    }] : [];
  });
}

export async function recordCandidateEnrichmentAttempt(input: {
  workspaceId: string | number;
  candidateId: string | number;
  attemptedAt: string;
  eventCount: number;
  researchPass?: number;
  researchRevision?: number;
}) {
  const eventCount = Math.max(0, Math.floor(input.eventCount));
  const attemptedAt = new Date(input.attemptedAt);
  if (!Number.isFinite(attemptedAt.getTime())) {
    throw new Error("Enrichment attempt time must be a valid timestamp");
  }
  const result = await db().rpc("complete_candidate_enrichment_attempt", {
    p_workspace_id: workspaceId(input.workspaceId),
    p_candidate_id: Number(input.candidateId),
    p_event_count: eventCount,
    p_attempted_at: attemptedAt.toISOString(),
    p_research_revision: Math.max(0, Math.floor(input.researchRevision ?? 0)),
  });
  fail(result.error);
}

export async function claimCandidateBriefingBacklog(
  workspace: string | number,
  limit = 12,
) {
  if (!hasSupabaseAdminEnv()) return [];
  const wid = workspaceId(workspace);
  const boundedLimit = Math.min(50, Math.max(0, Math.floor(limit)));
  if (!boundedLimit) return [];
  const claim = await db().rpc("claim_candidate_brief_batch", {
    p_workspace_id: wid,
    p_match_count: boundedLimit,
    p_claim_seconds: 300,
  });
  fail(claim.error);
  const rows = claim.data ?? [];
  const ids = rows.map((row) => Number(row.candidate_id)).filter(Number.isFinite);
  if (!ids.length) return [];
  const candidatesResult = await db().from("candidates").select("*").in("id", ids);
  fail(candidatesResult.error);
  const candidates = await hydrate((candidatesResult.data ?? []) as CandidateRow[]);
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  return rows.flatMap((row) => {
    const candidate = byId.get(String(row.candidate_id));
    return candidate
      ? [{ candidate, evidenceFingerprint: row.evidence_fingerprint }]
      : [];
  });
}

export async function releaseCandidateBriefClaim(
  workspace: string | number,
  candidateId: string | number,
) {
  if (!hasSupabaseAdminEnv()) return;
  // Generation and evidence-contract failures must not be reclaimed by every
  // half-hour worker. The claim column also acts as a durable retry-after time.
  const retryAt = new Date(Date.now() + 6 * 60 * 60 * 1_000).toISOString();
  const { error } = await db()
    .from("candidates")
    .update({ brief_claimed_until: retryAt })
    .eq("workspace_id", workspaceId(workspace))
    .eq("id", Number(candidateId));
  fail(error);
}

function mapCriterion(row: CriterionProfileRow): CriterionProfile {
  const thresholds = record(row.thresholds); const digest = record(row.digest_config); const weights = record(row.signal_weights);
  const configuredDays = Array.isArray(digest.digestDaysOfWeek)
    ? digest.digestDaysOfWeek.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    : [];
  const signals: CriterionSignal[] = Array.isArray(weights.signals) ? (weights.signals as CriterionSignal[]) : Object.entries(weights).filter(([,v]) => typeof v === "number")
    .map(([key,value]) => ({ key, label: key.replace(/([A-Z])/g," $1"), description:"", weight:Number(value), enabled:true }));
  return { id:String(row.id), name:row.name, version:row.version, status:row.status as CriterionProfile["status"], lookForMarkdown:row.look_for_md,
    avoidMarkdown:row.avoid_md, signals, minimumScore:parseMinimumScore(thresholds.minimumScore), minimumConfidence:Number(thresholds.minimumConfidence ?? .6),
    weeklyCandidateCount:Number(digest.weeklyCandidateCount ?? 12), digestCadence:parseDigestCadence(digest.digestCadence), digestDaysOfWeek:configuredDays.length ? [...new Set(configuredDays)].sort((a,b)=>a-b) : [1], digestDeliveryHourUtc:Math.min(23, Math.max(0, Math.trunc(Number(digest.digestDeliveryHourUtc ?? 15)))), digestDeliveryMinuteUtc:[0,15,30,45].includes(Number(digest.digestDeliveryMinuteUtc)) ? Number(digest.digestDeliveryMinuteUtc) : 0, digestPreparationLeadHours:Math.min(12, Math.max(1, Math.trunc(Number(digest.digestPreparationLeadHours ?? 3)))), explorationRate:Number(row.exploration_rate), learningRate:Number(row.learning_rate),
    lastLearnedAt:row.update_origin === "learned" ? row.updated_at : null, trainingSampleCount:row.training_sample_count };
}

export async function getActiveCriterionProfile(workspace?: string | number) {
  if (!hasSupabaseAdminEnv()) return null;
  const { data,error } = await db().from("criterion_profiles").select("*").eq("workspace_id",workspaceId(workspace)).eq("status","active").maybeSingle(); fail(error);
  return data ? mapCriterion(data as CriterionProfileRow) : null;
}

export async function createCriterionProfileVersion(workspace: string | number, input: CriterionProfileVersionInput) {
  const client=db(); const wid=workspaceId(workspace); const current=await getActiveCriterionProfile(wid);
  const latest=await client.from("criterion_profiles").select("version").eq("workspace_id",wid).order("version",{ascending:false}).limit(1); fail(latest.error);
  const version=Number((latest.data?.[0] as Record<string,unknown>|undefined)?.version ?? 0)+1;
  const {data,error}=await client.from("criterion_profiles").insert({ workspace_id:wid,parent_id:current?.id ? Number(current.id):null,name:input.name ?? current?.name ?? "Unfound criterion",
    version,status:"draft",update_origin:input.origin ?? "human",look_for_md:input.lookForMarkdown ?? current?.lookForMarkdown ?? "",avoid_md:input.avoidMarkdown ?? current?.avoidMarkdown ?? "",
    signal_weights:JSON.parse(JSON.stringify({signals:input.signals ?? current?.signals ?? []})) as Json,thresholds:{minimumScore:input.minimumScore ?? current?.minimumScore ?? 25,minimumConfidence:input.minimumConfidence ?? current?.minimumConfidence ?? .6},
    digest_config:{weeklyCandidateCount:input.weeklyCandidateCount ?? current?.weeklyCandidateCount ?? 12,digestCadence:input.digestCadence ?? current?.digestCadence ?? "weekly",digestDaysOfWeek:input.digestDaysOfWeek ?? current?.digestDaysOfWeek ?? [1],digestDeliveryHourUtc:input.digestDeliveryHourUtc ?? current?.digestDeliveryHourUtc ?? 15,digestDeliveryMinuteUtc:input.digestDeliveryMinuteUtc ?? current?.digestDeliveryMinuteUtc ?? 0,digestPreparationLeadHours:input.digestPreparationLeadHours ?? current?.digestPreparationLeadHours ?? 3},learning_rate:input.learningRate ?? current?.learningRate ?? .01,
    exploration_rate:input.explorationRate ?? current?.explorationRate ?? .1,training_sample_count:input.trainingSampleCount ?? current?.trainingSampleCount ?? 0,
    change_summary:input.changeSummary,change_set:input.changeSet ?? {} }).select("*").single(); fail(error);
  if(input.activate !== false){ const retired=await client.from("criterion_profiles").update({status:"retired"}).eq("workspace_id",wid).eq("status","active"); fail(retired.error);
    const active=await client.from("criterion_profiles").update({status:"active",activated_at:new Date().toISOString()}).eq("id",Number((data as Record<string,unknown>).id)).select("*").single(); fail(active.error); return mapCriterion(active.data as CriterionProfileRow); }
  return mapCriterion(data as CriterionProfileRow);
}

export async function recordCandidateFeedback(input: RecordCandidateFeedbackInput) {
  const userId=input.userId ?? process.env.UNFOUND_ACTOR_USER_ID ?? null;
  const actorKey=input.actorKey?.trim() || "shared-dashboard";
  const {error}=await db().from("candidate_feedback").insert({workspace_id:workspaceId(input.workspaceId),candidate_id:Number(input.candidateId),user_id:userId,
    actor_key:actorKey,action:input.action,reason_code:input.reasonCode,note:input.note,weight:input.weight ?? 1,context:input.context ?? {}}); fail(error);
}

export async function listTasteFeedback(workspace: string|number, limit=500): Promise<TasteFeedbackRecord[]> {
  if(!hasSupabaseAdminEnv()) return []; const wid=workspaceId(workspace);
  const {data,error}=await db().from("candidate_feedback").select("id,candidate_id,action,reason_code,weight,created_at,candidates(score_components)").eq("workspace_id",wid).order("created_at",{ascending:false}).limit(limit); fail(error);
  return ((data ?? []) as Array<Record<string,unknown>>).map(row=>({id:String(row.id),candidateId:String(row.candidate_id),action:String(row.action),reasonCode:row.reason_code?String(row.reason_code):null,
    weight:Number(row.weight),scoreComponents:numberRecord(record(row.candidates).score_components),createdAt:String(row.created_at)}));
}

export async function rankCandidatesForDigest(workspace: string|number, options:{minimumScore?:number;limit?:number;excludeDays?:number}={}):Promise<RankedCandidate[]> {
  if(!hasSupabaseAdminEnv()) return []; const {data,error}=await db().rpc("rank_candidates_for_digest",{p_workspace_id:workspaceId(workspace),p_min_score:options.minimumScore ?? 25,
    p_match_count:Math.min(100,options.limit ?? 12),p_exclude_days:options.excludeDays ?? 30}); fail(error);
  return ((data ?? []) as Array<Record<string,unknown>>).map(row=>({candidateId:String(row.candidate_id ?? row.id),slug:String(row.slug),name:String(row.canonical_name ?? row.name),headline:String(row.headline ?? ""),
    score:Number(row.score),momentum:Number(row.momentum),confidence:Number(row.confidence),latestEventAt:row.latest_event_at?String(row.latest_event_at):null,rankScore:Number(row.rank_score ?? row.score)}));
}

function mapDigest(row: DigestRow): DigestRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    dedupeKey: row.dedupe_key,
    criterionProfileId: row.criterion_profile_id === null ? null : String(row.criterion_profile_id),
    status: row.status as DigestRecord["status"],
    periodStart: row.period_start,
    periodEnd: row.period_end,
    subject: row.subject,
    previewText: row.preview_text,
    candidateCount: row.candidate_count,
    recipientCount: row.recipient_count,
    generatedAt: row.generated_at,
    scheduledFor: row.scheduled_for,
    sentAt: row.sent_at,
    providerMessageId: row.provider_message_id,
    deliveryMetadata: row.delivery_metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseDigestEnvelope(data: Json, flag: "created" | "claimed") {
  const envelope = record(data);
  const digest = record(envelope.digest) as unknown as DigestRow;
  if (typeof envelope[flag] !== "boolean" || !Number.isSafeInteger(Number(digest.id))) {
    throw new Error("Database returned an invalid digest result");
  }
  return { value: envelope[flag] as boolean, digest: mapDigest(digest) };
}

export async function createDigest(input: CreateDigestInput): Promise<CreateDigestResult> {
  const dedupeKey = input.dedupeKey.trim();
  if (!dedupeKey || dedupeKey.length > 200) throw new Error("Digest dedupe key must be between 1 and 200 characters");

  const items = JSON.parse(JSON.stringify(input.items.map((item) => ({
    candidate_id: Number(item.candidateId),
    rank: item.rank,
    section: item.section ?? "top_discoveries",
    score_at_generation: item.score,
    headline_snapshot: item.headline,
    summary_snapshot_md: item.summaryMarkdown,
    why_now_snapshot_md: item.whyNowMarkdown,
    evidence_links: item.evidenceLinks ?? [],
    payload_snapshot: item.payloadSnapshot,
  })))) as Json;
  const { data, error } = await db().rpc("create_or_get_digest", {
    p_workspace_id: workspaceId(input.workspaceId),
    p_dedupe_key: dedupeKey,
    p_criterion_profile_id: input.criterionProfileId === null || input.criterionProfileId === undefined
      ? null
      : Number(input.criterionProfileId),
    p_period_start: input.periodStart,
    p_period_end: input.periodEnd,
    p_subject: input.subject,
    p_preview_text: input.previewText ?? "",
    p_scheduled_for: input.scheduledFor ?? null,
    p_items: items,
  });
  fail(error);
  const result = parseDigestEnvelope(data, "created");
  return { created: result.value, digest: result.digest };
}

export async function listDigestCandidateSnapshots(
  id: string | number,
  workspace: string | number,
): Promise<Json[]> {
  const { data, error } = await db().from("digest_items").select("payload_snapshot").eq(
    "workspace_id",
    workspaceId(workspace),
  ).eq("digest_id", Number(id)).order("rank");
  fail(error);
  return ((data ?? []) as Array<Pick<DigestItemRow, "payload_snapshot">>).map(
    (item) => item.payload_snapshot,
  );
}

export async function claimDigestDelivery(
  id: string | number,
  workspace: string | number,
  staleAfterMinutes = 15,
  retryWindowMinutes = 1380,
): Promise<ClaimDigestDeliveryResult | null> {
  const requestedLease = Number.isFinite(staleAfterMinutes) ? Math.trunc(staleAfterMinutes) : 15;
  const requestedRetryWindow = Number.isFinite(retryWindowMinutes) ? Math.trunc(retryWindowMinutes) : 1380;
  const { data, error } = await db().rpc("claim_digest_delivery", {
    p_workspace_id: workspaceId(workspace),
    p_digest_id: Number(id),
    p_stale_after_minutes: Math.max(5, Math.min(60, requestedLease)),
    p_retry_window_minutes: Math.max(60, Math.min(1380, requestedRetryWindow)),
  });
  fail(error);
  if (data === null) return null;
  const result = parseDigestEnvelope(data, "claimed");
  return { claimed: result.value, digest: result.digest };
}

export async function updateDigestDelivery(
  id: string | number,
  workspace: string | number,
  input: UpdateDigestDeliveryInput,
): Promise<DigestRecord | null> {
  const { data, error } = await db().from("digests").update({
    status: input.status,
    recipient_count: input.recipientCount,
    generated_at: input.generatedAt,
    sent_at: input.sentAt,
    provider_message_id: input.providerMessageId,
    delivery_metadata: input.deliveryMetadata,
  }).eq("workspace_id", workspaceId(workspace)).eq("id", Number(id)).eq("status", "sending").select("*").maybeSingle();
  fail(error);
  return data ? mapDigest(data as DigestRow) : null;
}

function mapSubscriber(row:DigestSubscriberRow):DigestSubscriber{return{id:String(row.id),workspaceId:String(row.workspace_id),email:row.email,displayName:row.display_name,status:row.status as DigestSubscriber["status"],deliveryStatus:row.delivery_status as DigestSubscriber["deliveryStatus"],lastSentAt:row.last_sent_at,createdAt:row.created_at};}
export async function listDigestSubscribers(workspace:string|number){if(!hasSupabaseAdminEnv())return[];const{data,error}=await db().from("digest_subscribers").select("*").eq("workspace_id",workspaceId(workspace)).order("created_at");fail(error);return((data??[])as DigestSubscriberRow[]).map(mapSubscriber);}
export async function addDigestSubscriber(
  workspace: string | number,
  input: DigestSubscriberMutation,
) {
  const client = db();
  const wid = workspaceId(workspace);
  const email = input.email?.trim().toLocaleLowerCase("en-US");
  if (!email) throw new Error("Subscriber email is required");

  const findExisting = async () => {
    const escapedEmail = email.replace(/[\\%_]/g, "\\$&");
    const result = await client
      .from("digest_subscribers")
      .select("*")
      .eq("workspace_id", wid)
      .ilike("email", escapedEmail)
      .maybeSingle();
    fail(result.error);
    return result.data as DigestSubscriberRow | null;
  };
  const updateExisting = async (existing: DigestSubscriberRow) => {
    const mustRemainPaused = ["bounced", "complained"].includes(existing.delivery_status);
    const result = await client
      .from("digest_subscribers")
      .update({
        email,
        display_name:
          input.displayName === undefined ? existing.display_name : input.displayName,
        status: mustRemainPaused ? "paused" : input.status ?? "active",
      })
      .eq("workspace_id", wid)
      .eq("id", existing.id)
      .select("*")
      .single();
    fail(result.error);
    return mapSubscriber(result.data as DigestSubscriberRow);
  };

  const existing = await findExisting();
  if (existing) return updateExisting(existing);

  const inserted = await client
    .from("digest_subscribers")
    .insert({
      workspace_id: wid,
      email,
      display_name: input.displayName,
      status: input.status ?? "active",
    })
    .select("*")
    .single();
  if (!inserted.error) return mapSubscriber(inserted.data as DigestSubscriberRow);

  // A concurrent add can win after the lookup. Resolve the unique-key race by
  // returning the now-existing subscriber instead of surfacing a spurious 500.
  if (inserted.error.code === "23505") {
    const raced = await findExisting();
    if (raced) return updateExisting(raced);
  }
  fail(inserted.error);
  throw new Error("Subscriber could not be added");
}
export async function updateDigestSubscriber(
  workspace: string | number,
  id: string | number,
  input: DigestSubscriberMutation,
) {
  const client = db();
  const wid = workspaceId(workspace);
  const subscriberId = Number(id);
  if (input.status === "active") {
    const existing = await client
      .from("digest_subscribers")
      .select("delivery_status")
      .eq("workspace_id", wid)
      .eq("id", subscriberId)
      .maybeSingle();
    fail(existing.error);
    const deliveryStatus = String(
      (existing.data as Pick<DigestSubscriberRow, "delivery_status"> | null)?.delivery_status ?? "",
    );
    if (["bounced", "complained"].includes(deliveryStatus)) {
      throw new SubscriberDeliveryBlockedError();
    }
  }
  const { data, error } = await client
    .from("digest_subscribers")
    .update({
      email: input.email,
      display_name: input.displayName,
      status: input.status,
      delivery_status: input.deliveryStatus,
      last_sent_at: input.lastSentAt,
    })
    .eq("workspace_id", wid)
    .eq("id", subscriberId)
    .select("*")
    .single();
  fail(error);
  return mapSubscriber(data as DigestSubscriberRow);
}
export async function removeDigestSubscriber(workspace:string|number,id:string|number){const{error}=await db().from("digest_subscribers").delete().eq("workspace_id",workspaceId(workspace)).eq("id",Number(id));fail(error);}
export async function updateSubscriberDeliveries(workspace:string|number,updates:SubscriberDeliveryUpdate[]){for(const update of updates)await updateDigestSubscriber(workspace,update.subscriberId,{deliveryStatus:update.deliveryStatus,lastSentAt:update.lastSentAt});}

function emptyDashboardData(readiness: DataReadiness): DashboardData & DataReadiness {
  return {
    candidates: [],
    recentEvents: [],
    graph: { nodes: [], edges: [] },
    sources: [],
    criterion: emptyCriterion,
    subscribers: [],
    metrics: [],
    pipelineActivity: [],
    weeklyTrend: [],
    generatedAt: new Date().toISOString(),
    ...readiness,
  };
}

export async function getDashboardData(
  workspace?: string | number,
): Promise<DashboardData & DataReadiness> {
  const ready = getDataReadiness(workspace);
  if (!hasSupabaseAdminEnv()) return emptyDashboardData(ready);

  try {
    const [candidates, sources, criterion, subscribers] = await Promise.all([
      listCandidates({ limit: 100 }, workspace),
      listSources(workspace),
      getActiveCriterionProfile(workspace),
      listDigestSubscribers(String(workspaceId(workspace))),
    ]);
    return {
      candidates,
      recentEvents: candidates
        .flatMap((candidate) => candidate.events)
        .sort((a, b) => b.discoveredAt.localeCompare(a.discoveredAt))
        .slice(0, 20),
      graph: { nodes: [], edges: [] },
      sources,
      criterion: criterion ?? emptyCriterion,
      subscribers,
      metrics: [
        { label: "Candidates", value: candidates.length, change: 0 },
        {
          label: "New signals",
          value: candidates.reduce((sum, candidate) => sum + candidate.events.length, 0),
          change: 0,
        },
      ],
      pipelineActivity: [],
      weeklyTrend: [],
      generatedAt: new Date().toISOString(),
      ...ready,
      dataMode: candidates.length || sources.length ? "live" : "empty",
    };
  } catch (error) {
    if (!(error instanceof DataNotConfiguredError)) throw error;
    return emptyDashboardData({
      ...ready,
      dataMode: "unconfigured",
      missingCapabilities: [...new Set([...ready.missingCapabilities, "supabase-schema"])],
    });
  }
}
