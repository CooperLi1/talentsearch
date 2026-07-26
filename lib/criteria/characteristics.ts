import type {
  Candidate,
  CriterionCharacteristic,
} from "@/lib/domain/types";

export const CRITERION_CHARACTERISTIC_KEYS = [
  "explicitHighSchool",
  "highSchoolTechInternship",
  "ioiRecognition",
  "targetSchool",
  "githubHighActivity",
  "hackerNewsHighActivity",
  "lowXFollowers",
  "activeButUndiscovered",
] as const;

export type CriterionCharacteristicKey =
  (typeof CRITERION_CHARACTERISTIC_KEYS)[number];

export const DEFAULT_CRITERION_CHARACTERISTICS: CriterionCharacteristic[] = [
  {
    key: "explicitHighSchool",
    label: "Explicitly in high school",
    description:
      "A cited profile or result explicitly lists high-school enrollment. Age is never inferred.",
    enabled: false,
    mode: "prefer",
  },
  {
    key: "highSchoolTechInternship",
    label: "Tech internship in high school",
    description:
      "Explicit high-school evidence plus a cited internship or engineering role.",
    enabled: false,
    mode: "prefer",
  },
  {
    key: "ioiRecognition",
    label: "IOI recognition",
    description:
      "An official International Olympiad in Informatics result, medal, or placement.",
    enabled: false,
    mode: "prefer",
  },
  {
    key: "targetSchool",
    label: "Listed target school",
    description:
      "The candidate's cited school or affiliation matches one of your configured schools.",
    enabled: false,
    mode: "prefer",
    values: [],
  },
  {
    key: "githubHighActivity",
    label: "High GitHub activity",
    description:
      "A high volume of public repositories, pushes, or recent public GitHub events.",
    enabled: false,
    mode: "prefer",
    threshold: 0.45,
  },
  {
    key: "hackerNewsHighActivity",
    label: "High Hacker News activity",
    description:
      "A high volume of public Hacker News submissions or recent posts.",
    enabled: false,
    mode: "prefer",
    threshold: 0.4,
  },
  {
    key: "lowXFollowers",
    label: "Under 500 X followers",
    description:
      "A verified X profile is present and its public follower count is below the threshold.",
    enabled: false,
    mode: "prefer",
    threshold: 500,
  },
  {
    key: "activeButUndiscovered",
    label: "Active but undiscovered",
    description:
      "High public activity combined with relatively low public recognition.",
    enabled: false,
    mode: "prefer",
    threshold: 0.35,
  },
];

export type CandidateCharacteristicMatch = {
  key: CriterionCharacteristicKey;
  label: string;
  matched: boolean;
  evidence: string;
};

const HIGH_SCHOOL =
  /\b(?:high school|secondary school|college preparatory|college prep|grade (?:9|10|11|12)|(?:9th|10th|11th|12th)[ -]?grader)\b/iu;
const INTERNSHIP =
  /\b(?:intern(?:ed|ship)?|software engineering intern|research intern|engineering intern)\b/iu;
const IOI =
  /\b(?:IOI|International Olympiad in Informatics)\b/iu;
const RECOGNITION =
  /\b(?:gold|silver|bronze|medal(?:ist)?|winner|placed|rank(?:ed)?|honou?rable mention)\b/iu;

function clean(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}

function candidateText(candidate: Candidate) {
  return clean(
    [
      candidate.stage,
      candidate.school,
      candidate.headline,
      candidate.biography,
      ...(candidate.affiliations ?? []),
      ...candidate.events.flatMap((event) => [
        event.title,
        event.summaryMarkdown,
        event.evidenceExcerpt,
        event.sourceLabel,
        ...(event.tags ?? []),
      ]),
    ]
      .filter(Boolean)
      .join(" "),
  );
}

function sourceMetric(
  candidate: Candidate,
  source: string,
  keys: string[],
) {
  return Math.max(
    0,
    ...candidate.events
      .filter(
        (event) =>
          event.sourceLabel.toLocaleLowerCase("en-US") ===
          source.toLocaleLowerCase("en-US"),
      )
      .flatMap((event) => keys.map((key) => event.metrics?.[key] ?? 0)),
  );
}

function thresholdFor(
  rules: CriterionCharacteristic[],
  key: CriterionCharacteristicKey,
  fallback: number,
) {
  const configured = Number(rules.find((rule) => rule.key === key)?.threshold);
  return Number.isFinite(configured) ? configured : fallback;
}

export function mergeCriterionCharacteristics(
  configured: CriterionCharacteristic[] | undefined,
) {
  const byKey = new Map((configured ?? []).map((rule) => [rule.key, rule]));
  return DEFAULT_CRITERION_CHARACTERISTICS.map((fallback) => {
    const stored = byKey.get(fallback.key);
    if (!stored) return { ...fallback, values: [...(fallback.values ?? [])] };
    return {
      ...fallback,
      ...stored,
      label: fallback.label,
      description: fallback.description,
      values: Array.isArray(stored.values)
        ? stored.values.map(clean).filter(Boolean).slice(0, 50)
        : [...(fallback.values ?? [])],
    };
  });
}

export function evaluateCandidateCharacteristics(
  candidate: Candidate,
  configured: CriterionCharacteristic[] = DEFAULT_CRITERION_CHARACTERISTICS,
): CandidateCharacteristicMatch[] {
  const rules = mergeCriterionCharacteristics(configured);
  const text = candidateText(candidate);
  const explicitHighSchool = HIGH_SCHOOL.test(text);
  const githubActivity = Math.max(
    sourceMetric(candidate, "github", [
      "githubActivity90d",
      "githubPublicEvents90d",
      "publicRepositories",
    ]) / 100,
    Number(candidate.scoreComponents.githubActivity ?? 0),
  );
  const hackerNewsActivity = Math.max(
    Math.log1p(
      sourceMetric(candidate, "hacker-news", [
        "hackerNewsActivity90d",
        "submissions",
      ]),
    ) / Math.log1p(1_000),
    Number(candidate.scoreComponents.hackerNewsActivity ?? 0),
  );
  const xFollowers = sourceMetric(candidate, "x", ["followers"]);
  const hasXProfile = candidate.identities.some(
    (identity) => identity.provider === "x" && identity.resolutionStatus === "resolved",
  );
  const activity = Number(candidate.scoreComponents.activityVolume ?? 0);
  const recognition = Number(candidate.scoreComponents.publicRecognition ?? 0);
  const targetSchools =
    rules.find((rule) => rule.key === "targetSchool")?.values ?? [];
  const schoolText = clean(
    [candidate.school, ...(candidate.affiliations ?? []), text]
      .filter(Boolean)
      .join(" "),
  ).toLocaleLowerCase("en-US");
  const matchedTarget = targetSchools.find((school) =>
    schoolText.includes(school.toLocaleLowerCase("en-US")),
  );
  const ioiEvidence = IOI.test(text) && RECOGNITION.test(text);

  const values: Record<
    CriterionCharacteristicKey,
    Pick<CandidateCharacteristicMatch, "matched" | "evidence">
  > = {
    explicitHighSchool: {
      matched: explicitHighSchool,
      evidence: explicitHighSchool
        ? "A cited source explicitly lists high-school enrollment."
        : "No explicit high-school evidence.",
    },
    highSchoolTechInternship: {
      matched: explicitHighSchool && INTERNSHIP.test(text),
      evidence:
        explicitHighSchool && INTERNSHIP.test(text)
          ? "Cited evidence includes both high-school enrollment and an internship."
          : "Both explicit high-school and internship evidence are required.",
    },
    ioiRecognition: {
      matched: ioiEvidence,
      evidence: ioiEvidence
        ? "An official IOI result or placement is present."
        : "No official IOI recognition found.",
    },
    targetSchool: {
      matched: Boolean(matchedTarget),
      evidence: matchedTarget
        ? `Matched configured school: ${matchedTarget}.`
        : targetSchools.length
          ? "No configured school matched."
          : "No target schools configured.",
    },
    githubHighActivity: {
      matched:
        githubActivity >=
        thresholdFor(rules, "githubHighActivity", 0.45),
      evidence: `GitHub activity index ${Math.round(githubActivity * 100)}.`,
    },
    hackerNewsHighActivity: {
      matched:
        hackerNewsActivity >=
        thresholdFor(rules, "hackerNewsHighActivity", 0.4),
      evidence: `Hacker News activity index ${Math.round(
        hackerNewsActivity * 100,
      )}.`,
    },
    lowXFollowers: {
      matched:
        hasXProfile &&
        xFollowers <
          thresholdFor(rules, "lowXFollowers", 500),
      evidence: hasXProfile
        ? `${Math.round(xFollowers)} public X followers.`
        : "No verified X profile with follower metrics.",
    },
    activeButUndiscovered: {
      matched:
        activity >= 0.35 &&
        recognition <=
          thresholdFor(rules, "activeButUndiscovered", 0.35),
      evidence: `Activity ${Math.round(activity * 100)}, recognition ${Math.round(
        recognition * 100,
      )}.`,
    },
  };

  return rules.map((rule) => ({
    key: rule.key as CriterionCharacteristicKey,
    label: rule.label,
    ...values[rule.key as CriterionCharacteristicKey],
  }));
}

export function candidatePassesRequiredCharacteristics(
  candidate: Candidate,
  rules: CriterionCharacteristic[],
) {
  const enabledRequired = mergeCriterionCharacteristics(rules).filter(
    (rule) => rule.enabled && rule.mode === "require",
  );
  if (!enabledRequired.length) return true;
  const matches = new Map(
    evaluateCandidateCharacteristics(candidate, rules).map((match) => [
      match.key,
      match.matched,
    ]),
  );
  return enabledRequired.every(
    (rule) =>
      matches.get(rule.key as CriterionCharacteristicKey) === true,
  );
}

export function preferredCharacteristicCount(
  candidate: Candidate,
  rules: CriterionCharacteristic[],
) {
  const enabledPreferred = new Set<CriterionCharacteristicKey>(
    mergeCriterionCharacteristics(rules)
      .filter((rule) => rule.enabled && rule.mode === "prefer")
      .map((rule) => rule.key as CriterionCharacteristicKey),
  );
  return evaluateCandidateCharacteristics(candidate, rules).filter(
    (match) => match.matched && enabledPreferred.has(match.key),
  ).length;
}
