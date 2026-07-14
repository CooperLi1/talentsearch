export const EVENT_TYPE_LABELS: Record<string, string> = {
  project_created: "New project",
  project_momentum: "Project momentum",
  open_source_contribution: "Open-source work",
  paper_published: "Published research",
  competition_result: "Competition result",
  hackathon_result: "Hackathon result",
  community_recognition: "Community recognition",
  social_graph_signal: "Network signal",
  profile_observed: "New profile",
  fellowship_or_grant: "Fellowship or grant",
  other: "Other evidence",
};

export const STATUS_LABELS: Record<string, string> = {
  new: "New",
  watching: "Watching",
  saved: "Shortlisted",
  contacted: "Contacted",
  interviewing: "Interviewing",
  fellow: "Fellow",
  passed: "Passed",
  archived: "Archived",
};

export type SearchFacetCandidate = {
  domains: string[];
  eventTypes: string[];
  location: string;
  sourceLabels: string[];
  stage: string;
  status: string;
};

export type SearchFacetOption = {
  count: number;
  label: string;
  value: string;
};

export type SearchFacetOptions = {
  domains: SearchFacetOption[];
  eventTypes: SearchFacetOption[];
  locations: SearchFacetOption[];
  sources: SearchFacetOption[];
  stages: SearchFacetOption[];
  statuses: SearchFacetOption[];
};

function clean(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}

function countOptions(
  values: string[],
  maximum: number,
  labels: Record<string, string> = {},
): SearchFacetOption[] {
  const counts = new Map<string, { count: number; value: string }>();
  for (const rawValue of values) {
    const value = clean(rawValue);
    if (!value) continue;
    const key = value.toLocaleLowerCase("en-US");
    const current = counts.get(key);
    counts.set(key, {
      count: (current?.count ?? 0) + 1,
      value: current?.value ?? value,
    });
  }
  return [...counts.values()]
    .map(({ count, value }) => ({ count, label: labels[value] ?? value, value }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
    .slice(0, maximum);
}

export function buildSearchFacetOptions(
  candidates: SearchFacetCandidate[],
): SearchFacetOptions {
  return {
    domains: countOptions(candidates.flatMap((candidate) => candidate.domains), 12),
    eventTypes: countOptions(
      candidates.flatMap((candidate) => [...new Set(candidate.eventTypes)]),
      Object.keys(EVENT_TYPE_LABELS).length,
      EVENT_TYPE_LABELS,
    ),
    locations: countOptions(candidates.map((candidate) => candidate.location), 12),
    sources: countOptions(
      candidates.flatMap((candidate) => [...new Set(candidate.sourceLabels)]),
      12,
    ),
    stages: countOptions(candidates.map((candidate) => candidate.stage), 10),
    statuses: countOptions(
      candidates.map((candidate) => candidate.status),
      Object.keys(STATUS_LABELS).length,
      STATUS_LABELS,
    ),
  };
}

export function candidateMatchesFacet(
  candidateValues: string[],
  selectedValues: string[],
) {
  if (!selectedValues.length) return true;
  const candidateSet = new Set(
    candidateValues.map((value) => clean(value).toLocaleLowerCase("en-US")),
  );
  return selectedValues.some((value) =>
    candidateSet.has(clean(value).toLocaleLowerCase("en-US")),
  );
}
