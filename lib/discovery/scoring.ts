import type {
  CandidateScore,
  DiscoveryEvent,
  GraphEdge,
  ScoringWeights,
} from "./types";
import { clamp } from "./connectors/shared";
import { evidencePublisher } from "./evidence-publishers";

export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = {
  achievementQuality: 0.25,
  trajectoryVelocity: 0.17,
  projectOriginality: 0.14,
  technicalComplexity: 0.15,
  networkProximity: 0.12,
  evidenceDiversity: 0.08,
  earlyness: 0.09,
};

function maxMetric(events: DiscoveryEvent[], key: string) {
  return Math.max(0, ...events.map((event) => event.metrics?.[key] ?? 0));
}

export function scoreCandidate(input: {
  events: DiscoveryEvent[];
  edges?: GraphEdge[];
  now?: Date;
  weights?: ScoringWeights;
}): CandidateScore {
  const { events, edges = [], now = new Date(), weights = DEFAULT_SCORING_WEIGHTS } = input;
  if (!events.length) {
    return {
      total: 0,
      features: {
        achievementQuality: 0,
        trajectoryVelocity: 0,
        projectOriginality: 0,
        technicalComplexity: 0,
        networkProximity: 0,
        evidenceDiversity: 0,
        earlyness: 0,
      },
      confidencePenalty: 1,
      stalenessPenalty: 1,
      explanations: ["No evidence events"],
    };
  }

  const rank = maxMetric(events, "rank");
  const citations = maxMetric(events, "citations");
  const momentum = maxMetric(events, "momentum");
  const achievementEvents = events.filter((event) =>
    ["competition_result", "hackathon_result", "paper_published", "fellowship_or_grant"].includes(
      event.type,
    ),
  );
  const achievementQuality = clamp(
    achievementEvents.length * 0.12 +
      (rank > 0 ? 0.55 / Math.sqrt(rank) : 0) +
      Math.log1p(citations) / 10,
  );

  const recentEvents = [
    ...new Map(
      events
        .filter(
          (event) =>
            !["profile_observed", "social_graph_signal", "identity_observed", "other"].includes(event.type) &&
            now.getTime() - new Date(event.occurredAt).getTime() <= 90 * 86_400_000,
        )
        .map((event) => [`${event.type}:${event.sourceUrl}`, event]),
    ).values(),
  ];
  const activeMonths = new Set(recentEvents.map((event) => event.occurredAt.slice(0, 7))).size;
  const trajectoryVelocity = clamp(
    Math.min(0.35, recentEvents.length * 0.045) +
      Math.min(0.2, activeMonths * 0.07) +
      Math.min(0.25, Math.log1p(momentum) / 3),
  );

  const buildEvents = events.filter((event) =>
    ["project_created", "project_momentum", "open_source_contribution"].includes(event.type),
  );
  const distinctProjects = new Set(buildEvents.map((event) => event.sourceUrl)).size;
  const distinctProjectTags = new Set(buildEvents.flatMap((event) => event.tags ?? [])).size;
  const technicalComplexity = clamp(
    maxMetric(events, "technicalComplexity") *
      Math.max(0.25, maxMetric(events, "technicalComplexityConfidence")),
  );
  const projectOriginality = clamp(
    (distinctProjects ? 0.04 : 0) +
      Math.min(0.16, Math.log1p(distinctProjects) / 12) +
      Math.min(0.04, distinctProjectTags * 0.005) +
      technicalComplexity * 0.62 +
      Math.min(0.14, momentum / 2),
  );

  const uniqueGraphTargets = new Set(
    edges.map((edge) => `${edge.target.identities[0]?.provider}:${edge.target.identities[0]?.externalId}`),
  ).size;
  const edgeNetworkProximity = clamp(
    edges.reduce((total, edge) => total + clamp(edge.weight), 0) / 5 + uniqueGraphTargets / 50,
  );
  const eventNetworkProximity = clamp(
    maxMetric(events, "graphSupportWeight") / 3 +
      maxMetric(events, "graphSourceIdentities") / 5 +
      maxMetric(events, "graphRelationTypes") / 8,
  );
  const networkProximity = Math.max(edgeNetworkProximity, eventNetworkProximity);

  const sources = new Set(
    events.map(evidencePublisher).filter((value): value is string => Boolean(value)),
  );
  const evidenceDiversity = clamp(sources.size / 4 + Math.min(0.25, events.length / 40));

  const followers = Math.max(maxMetric(events, "followers"), maxMetric(events, "friendOfCount"));
  const recognition = Math.log10(Math.max(1, followers + maxMetric(events, "points") * 20));
  const evidenceStrength = clamp(
    (achievementQuality + projectOriginality + technicalComplexity + trajectoryVelocity) / 4,
  );
  const earlyness = clamp(0.78 + evidenceStrength * 0.2 - recognition * 0.18);

  const features = {
    achievementQuality,
    trajectoryVelocity,
    projectOriginality,
    technicalComplexity,
    networkProximity,
    evidenceDiversity,
    earlyness,
  };
  const totalWeight = Object.values(weights).reduce((sum, value) => sum + value, 0) || 1;
  const weighted = (Object.keys(features) as Array<keyof typeof features>).reduce(
    (sum, key) => sum + features[key] * weights[key],
    0,
  ) / totalWeight;
  const averageConfidence =
    events.reduce((sum, event) => sum + clamp(event.confidence), 0) / events.length;
  const confidencePenalty = clamp(1 - averageConfidence, 0, 0.35);
  const latest = Math.max(...events.map((event) => new Date(event.occurredAt).getTime()));
  const ageDays = Math.max(0, (now.getTime() - latest) / 86_400_000);
  const stalenessPenalty = clamp(Math.max(0, ageDays - 30) / 365, 0, 0.25);
  const total = Math.round(clamp(weighted - confidencePenalty - stalenessPenalty) * 1000) / 10;

  const explanations: string[] = [];
  if (achievementQuality >= 0.5) explanations.push("Selective achievement or research evidence");
  if (trajectoryVelocity >= 0.5) explanations.push("Several meaningful signals arrived recently");
  if (projectOriginality >= 0.45) explanations.push("Repeated evidence of building or open-source work");
  if (technicalComplexity >= 0.5) explanations.push("Repository structure indicates meaningful technical depth");
  if (networkProximity >= 0.35) explanations.push("Credible collaboration or graph proximity");
  if (evidenceDiversity >= 0.5) explanations.push(`Corroborated across ${sources.size} sources`);
  if (earlyness >= 0.65) explanations.push("Strong signal relative to current public recognition");

  return { total, features, confidencePenalty, stalenessPenalty, explanations };
}
