import type {
  ConnectorSettings,
  DiscoveryConnector,
  DiscoveryEvent,
  ExternalIdentity,
  GraphEdge,
  PersonObservation,
  SourceKind,
} from "./types";
import { SOURCE_KINDS } from "./types";
import { mapLimit } from "./connectors/shared";
import { stableHash } from "./idempotency";

const SOURCE_KIND_SET = new Set<string>(SOURCE_KINDS);
const STRONG_EDGE_WEIGHT = 0.78;
const REPEATED_COAUTHOR_WEIGHT = 0.34;
const REPEATED_COLLABORATION_WEIGHT = 0.9;
const REPEATED_ENGAGEMENT_WEIGHT = 0.72;

type GraphEdgeRecord = {
  edge: GraphEdge;
  sourceKey: string;
  targetKeys: string[];
};

function normalizeIdentityPart(value: string) {
  return value.trim().normalize("NFKC").toLocaleLowerCase("en-US");
}

function identityKey(identity: ExternalIdentity) {
  const externalId = normalizeIdentityPart(identity.externalId);
  return externalId ? `${identity.provider}:${externalId}` : null;
}

function durableTargetKeys(person: PersonObservation) {
  return [...new Set(
    person.identities
      .filter((identity) => identity.provider !== "email" && identity.verified === true)
      .map(identityKey)
      .filter((key): key is string => Boolean(key)),
  )].sort();
}

function sourceIdentityKey(identity: ExternalIdentity) {
  if (identity.provider === "email") return null;
  return identityKey(identity);
}

function asPublicUrl(value: string | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function edgeSortKey(record: GraphEdgeRecord) {
  return [
    record.targetKeys.join("|"),
    record.sourceKey,
    record.edge.relation,
    asPublicUrl(record.edge.sourceUrl) ?? "",
    String(record.edge.weight),
  ].join("\u001f");
}

function supportKey(record: GraphEdgeRecord) {
  return [
    record.sourceKey,
    record.edge.relation,
    asPublicUrl(record.edge.sourceUrl) ?? "",
  ].join("\u001f");
}

function publicPerson(records: GraphEdgeRecord[]): PersonObservation {
  const ranked = records
    .map((record) => record.edge.target)
    .sort((left, right) => {
      const completeness = (person: PersonObservation) =>
        person.identities.length * 4 +
        Number(Boolean(person.headline)) * 2 +
        Number(Boolean(person.biography)) * 2 +
        Number(Boolean(person.websiteUrl)) * 2 +
        Number(Boolean(person.location)) +
        (person.affiliations?.length ?? 0);
      return (
        completeness(right) - completeness(left) ||
        left.displayName.localeCompare(right.displayName) ||
        left.sourceUrl.localeCompare(right.sourceUrl)
      );
    });
  const base = ranked[0];
  const identities = new Map<string, ExternalIdentity>();
  for (const person of ranked) {
    for (const identity of person.identities) {
      if (identity.provider === "email" || identity.verified !== true) continue;
      const key = identityKey(identity);
      if (key && !identities.has(key)) identities.set(key, identity);
    }
  }
  return {
    displayName: base.displayName,
    identities: [...identities.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, identity]) => identity),
    headline: base.headline,
    biography: base.biography,
    location: base.location,
    affiliations: base.affiliations,
    avatarUrl: base.avatarUrl,
    websiteUrl: base.websiteUrl,
    explicitCareerStage: base.explicitCareerStage,
    sourceUrl: base.sourceUrl,
  };
}

function latestObservedAt(records: GraphEdgeRecord[], now: Date) {
  const timestamps = records
    .map((record) => Date.parse(record.edge.observedAt))
    .filter(Number.isFinite);
  return timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : now.toISOString();
}

function confidenceForGraphSupport(input: {
  distinctSources: number;
  strongEdge: boolean;
  repeatedCoauthor: boolean;
  repeatedCollaboration: boolean;
  repeatedEngagement: boolean;
  relationCount: number;
}) {
  let confidence = 0.58;
  if (input.distinctSources >= 2) {
    confidence += 0.07 + Math.min(0.05, (input.distinctSources - 2) * 0.02);
  }
  if (input.strongEdge) confidence += 0.08;
  if (input.repeatedCoauthor) confidence += 0.07;
  if (input.repeatedCollaboration) confidence += 0.06;
  if (input.repeatedEngagement) confidence += 0.04;
  confidence += Math.min(0.04, Math.max(0, input.relationCount - 1) * 0.02);
  return Math.min(0.82, Math.round(confidence * 1_000) / 1_000);
}

function sourceKindFor(records: GraphEdgeRecord[]): SourceKind | null {
  for (const record of records) {
    if (SOURCE_KIND_SET.has(record.edge.source.provider)) {
      return record.edge.source.provider as SourceKind;
    }
  }
  return null;
}

/**
 * Converts public graph evidence into conservative candidate events. This is deliberately
 * identity-based: names never join records, and duplicated weak follows do not manufacture
 * corroboration. The result is bounded and deterministic for the same evidence set.
 */
export function graphEdgesToCandidateEvents(input: {
  edges: GraphEdge[];
  now: Date;
  maxEdges?: number;
  maxCandidates?: number;
}): DiscoveryEvent[] {
  const now = input.now;
  const maxEdges = Math.min(5_000, Math.max(0, input.maxEdges ?? 2_000));
  const maxCandidates = Math.min(100, Math.max(0, input.maxCandidates ?? 50));
  if (!maxEdges || !maxCandidates) return [];

  const records = input.edges
    .map((edge): GraphEdgeRecord | null => {
      const sourceKey = sourceIdentityKey(edge.source);
      const targetKeys = durableTargetKeys(edge.target);
      if (!sourceKey || !targetKeys.length || !Number.isFinite(edge.weight)) return null;
      return { edge, sourceKey, targetKeys };
    })
    .filter((record): record is GraphEdgeRecord => Boolean(record))
    .sort((left, right) => edgeSortKey(left).localeCompare(edgeSortKey(right)))
    .slice(0, maxEdges);

  const parent = records.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    while (parent[index] !== index) {
      const next = parent[index];
      parent[index] = root;
      index = next;
    }
    return root;
  };
  const union = (left: number, right: number) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    parent[Math.max(leftRoot, rightRoot)] = Math.min(leftRoot, rightRoot);
  };
  const identityOwners = new Map<string, number>();
  records.forEach((record, index) => {
    for (const key of record.targetKeys) {
      const owner = identityOwners.get(key);
      if (owner === undefined) identityOwners.set(key, index);
      else union(index, owner);
    }
  });

  const groups = new Map<number, GraphEdgeRecord[]>();
  records.forEach((record, index) => {
    const root = find(index);
    const group = groups.get(root) ?? [];
    group.push(record);
    groups.set(root, group);
  });

  const events: DiscoveryEvent[] = [];
  for (const groupedRecords of groups.values()) {
    const uniqueSupports = new Map<string, GraphEdgeRecord>();
    for (const record of groupedRecords) {
      const key = supportKey(record);
      const existing = uniqueSupports.get(key);
      if (!existing || existing.edge.weight < record.edge.weight) uniqueSupports.set(key, record);
    }
    const supports = [...uniqueSupports.values()].sort((left, right) =>
      edgeSortKey(left).localeCompare(edgeSortKey(right)),
    );
    const source = sourceKindFor(supports);
    if (!source) continue;

    const distinctSources = new Set(supports.map((record) => record.sourceKey)).size;
    const maxWeight = Math.max(...supports.map((record) => Math.max(0, record.edge.weight)));
    const coauthorWeight = supports
      .filter((record) => record.edge.relation === "coauthors_with")
      .reduce((sum, record) => sum + Math.max(0, record.edge.weight), 0);
    const strongEdge = maxWeight >= STRONG_EDGE_WEIGHT;
    const repeatedCoauthor = coauthorWeight >= REPEATED_COAUTHOR_WEIGHT;
    const collaborationWeight = supports
      .filter((record) =>
        ["collaborates_with", "contributes_to"].includes(record.edge.relation),
      )
      .reduce((sum, record) => sum + Math.max(0, record.edge.weight), 0);
    const engagementWeight = supports
      .filter((record) => record.edge.relation === "engages_with")
      .reduce((sum, record) => sum + Math.max(0, record.edge.weight), 0);
    const repeatedCollaboration = collaborationWeight >= REPEATED_COLLABORATION_WEIGHT;
    const repeatedEngagement = engagementWeight >= REPEATED_ENGAGEMENT_WEIGHT;
    if (
      distinctSources < 2 &&
      !strongEdge &&
      !repeatedCoauthor &&
      !repeatedCollaboration &&
      !repeatedEngagement
    ) continue;

    const relations = [...new Set(supports.map((record) => record.edge.relation))].sort();
    const targetKeys = [...new Set(supports.flatMap((record) => record.targetKeys))].sort();
    const identityAnchor = targetKeys[0];
    const person = publicPerson(supports);
    const evidenceByUrl = new Map<string, DiscoveryEvent["evidence"][number]>();
    for (const record of supports) {
      const url = asPublicUrl(record.edge.sourceUrl);
      if (!url || evidenceByUrl.has(url)) continue;
      evidenceByUrl.set(url, {
        label: `${record.edge.relation.replaceAll("_", " ")} via ${record.edge.source.provider}`,
        url,
        publishedAt: record.edge.observedAt,
      });
    }
    const evidence = [...evidenceByUrl.values()].slice(0, 12);
    if (!evidence.length) continue;

    const occurredAt = latestObservedAt(supports, now);
    const relationText = relations.map((relation) => relation.replaceAll("_", " ")).join(", ");
    const reason =
      distinctSources >= 2
        ? `${distinctSources} distinct public identities point to this person through ${relationText}.`
        : repeatedCoauthor
          ? `Repeated public coauthor evidence points to this person.`
          : repeatedCollaboration
            ? `Repeated public collaboration evidence points to this person.`
            : repeatedEngagement
              ? `Repeated substantive public interactions point to this person.`
          : `A strong public ${relationText} connection points to this person.`;
    const confidence = confidenceForGraphSupport({
      distinctSources,
      strongEdge,
      repeatedCoauthor,
      repeatedCollaboration,
      repeatedEngagement,
      relationCount: relations.length,
    });
    const anchorHash = stableHash("graph-target-v1", identityAnchor);
    events.push({
      idempotencyKey: stableHash("graph-candidate-event-v1", identityAnchor),
      source,
      sourceExternalId: `graph:${anchorHash.slice(0, 40)}`,
      type: "social_graph_signal",
      title: `${person.displayName} surfaced through a public graph connection`,
      description: reason,
      occurredAt,
      discoveredAt: now.toISOString(),
      sourceUrl: evidence[0].url,
      evidence,
      person,
      metrics: {
        graphSourceIdentities: distinctSources,
        graphEvidenceLinks: evidence.length,
        graphRelationTypes: relations.length,
        graphMaxWeight: Math.min(1, maxWeight),
        graphSupportWeight: supports.reduce(
          (sum, record) => sum + Math.min(1, Math.max(0, record.edge.weight)),
          0,
        ),
      },
      raw: {
        graphPath: supports.slice(0, 12).map((record) => ({
          sourceProvider: record.edge.source.provider,
          sourceExternalId: record.edge.source.externalId,
          relation: record.edge.relation,
          targetIdentities: record.targetKeys,
          evidenceUrl: asPublicUrl(record.edge.sourceUrl),
          weight: Math.min(1, Math.max(0, record.edge.weight)),
        })),
      },
      tags: ["graph-discovery", ...relations.map((relation) => `relation:${relation}`)],
      confidence,
    });
  }

  return events
    .sort(
      (left, right) =>
        (right.metrics?.graphSupportWeight ?? 0) -
          (left.metrics?.graphSupportWeight ?? 0) ||
        right.confidence - left.confidence ||
        left.idempotencyKey.localeCompare(right.idempotencyKey),
    )
    .slice(0, maxCandidates);
}

function personKey(person: PersonObservation) {
  const identity = person.identities.find(
    (item) => item.provider !== "email" && item.verified === true && item.externalId.trim(),
  );
  return identity
    ? `${identity.provider}:${identity.externalId.toLocaleLowerCase("en-US")}`
    : null;
}

export async function expandDiscoveryGraph(input: {
  seeds: PersonObservation[];
  connectors: Map<SourceKind, DiscoveryConnector>;
  settings: Partial<Record<SourceKind, ConnectorSettings>>;
  now?: Date;
  maxDepth?: number;
  maxNodes?: number;
  maxEdgesPerSeed?: number;
  signal?: AbortSignal;
}): Promise<{ nodes: PersonObservation[]; edges: GraphEdge[]; warnings: string[] }> {
  const now = input.now ?? new Date();
  const maxDepth = Math.min(3, Math.max(0, input.maxDepth ?? 1));
  const maxNodes = Math.min(1_000, Math.max(0, input.maxNodes ?? 200));
  const maxEdgesPerSeed = Math.min(100, Math.max(1, input.maxEdgesPerSeed ?? 60));
  const maxEdges = Math.min(4_000, maxNodes * 5);
  const verifiedSeeds = input.seeds.filter((person) => personKey(person));
  const seen = new Set(verifiedSeeds.map(personKey).filter((key): key is string => Boolean(key)));
  const nodes = [...verifiedSeeds];
  const edges: GraphEdge[] = [];
  const warnings: string[] = [];
  let frontier = [...verifiedSeeds];

  for (let depth = 0; depth < maxDepth && frontier.length && nodes.length < maxNodes; depth += 1) {
    const expanded = await mapLimit(frontier, 3, async (person) => {
      const kinds = new Set(person.identities.map((identity) => identity.provider));
      const sourceEdges: GraphEdge[] = [];
      for (const kind of kinds) {
        if (!input.connectors.has(kind as SourceKind)) continue;
        const connector = input.connectors.get(kind as SourceKind)!;
        const settings = input.settings[kind as SourceKind];
        if (!connector.expandGraph || !settings?.enabled) continue;
        try {
          sourceEdges.push(
            ...(await connector.expandGraph({
              now,
              person,
              settings,
              signal: input.signal,
            })),
          );
        } catch (error) {
          warnings.push(
            `${connector.displayName} graph expansion failed: ${error instanceof Error ? error.message : "unknown error"}`,
          );
        }
      }
      return sourceEdges
        .filter((edge) => personKey(edge.target))
        .sort(
          (left, right) =>
            right.weight - left.weight ||
            left.relation.localeCompare(right.relation) ||
            left.sourceUrl.localeCompare(right.sourceUrl),
        )
        .slice(0, maxEdgesPerSeed);
    });
    const next: PersonObservation[] = [];
    const depthEdges = expanded
      .flat()
      .filter((edge) => personKey(edge.target))
      .sort(
        (left, right) =>
          right.weight - left.weight ||
          left.relation.localeCompare(right.relation) ||
          left.sourceUrl.localeCompare(right.sourceUrl),
      )
      .slice(0, Math.max(0, maxEdges - edges.length));
    const targetSupport = new Map<string, { weight: number; sources: Set<string> }>();
    for (const edge of depthEdges) {
      const key = personKey(edge.target)!;
      const support = targetSupport.get(key) ?? { weight: 0, sources: new Set<string>() };
      support.weight += Math.max(0, edge.weight);
      const sourceKey = sourceIdentityKey(edge.source);
      if (sourceKey) support.sources.add(sourceKey);
      targetSupport.set(key, support);
    }
    for (const edge of depthEdges) {
      edges.push(edge);
      const key = personKey(edge.target)!;
      const support = targetSupport.get(key)!;
      const safeToExpandFurther =
        edge.weight >= 0.6 || support.sources.size >= 2 || support.weight >= 0.9;
      if (
        safeToExpandFurther &&
        !seen.has(key) &&
        nodes.length + next.length < maxNodes
      ) {
        seen.add(key);
        next.push(edge.target);
      }
    }
    nodes.push(...next);
    frontier = next;
  }

  return { nodes, edges, warnings };
}
