import { fetchJson } from "./http";
import { clamp, mapLimit } from "./connectors/shared";

export type RepositoryTreeEntry = {
  path: string;
  type: "blob" | "tree" | string;
  size?: number;
};

export type RepositoryContributor = {
  contributions: number;
};

export type RepositoryComplexityAnalysis = {
  score: number;
  confidence: number;
  components: {
    sourceSurface: number;
    languageBreadth: number;
    testsAndCi: number;
    systemsAndResearch: number;
    authoredCodeRatio: number;
    historyDepth: number;
    contributorShape: number;
    documentationAndBenchmarks: number;
    hardConstraintMatch: number;
    tractionCorroboration: number;
  };
  indicators: string[];
  evidence: string[];
};

const SOURCE_EXTENSIONS = new Set([
  "c",
  "cc",
  "cpp",
  "cxx",
  "h",
  "hpp",
  "rs",
  "go",
  "py",
  "pyx",
  "ts",
  "tsx",
  "js",
  "jsx",
  "java",
  "kt",
  "swift",
  "scala",
  "rb",
  "php",
  "cs",
  "fs",
  "ex",
  "exs",
  "erl",
  "hs",
  "ml",
  "mli",
  "clj",
  "cljs",
  "sol",
  "v",
  "vhd",
  "sv",
  "asm",
  "s",
  "cu",
  "m",
  "mm",
  "r",
  "jl",
  "lua",
  "zig",
  "wasm",
]);

const VENDORED_PATH = /(^|\/)(node_modules|vendor|vendors|third_party|third-party|dist|build|target|\.next|coverage|generated|fixtures?\/vendor)(\/|$)/i;
const TEST_PATH = /(^|\/)(__tests__|tests?|specs?|testing)(\/|$)|\.(test|spec)\.[a-z0-9]+$/i;
const CI_PATH = /(^|\/)(\.github\/workflows|\.gitlab-ci\.yml|\.circleci|buildkite|jenkinsfile|azure-pipelines\.yml)(\/|$)/i;
const DOC_PATH = /(^|\/)(docs?|examples?|tutorials?)(\/|$)|(^|\/)readme(?:\.[a-z0-9]+)?$/i;
const BENCHMARK_PATH = /(^|\/)(benchmarks?|perf|evaluation|evals?)(\/|$)/i;
const MANIFEST_PATH = /(^|\/)(package\.json|cargo\.toml|go\.mod|pyproject\.toml|requirements[^/]*\.txt|pom\.xml|build\.gradle|cmakelists\.txt|makefile|flake\.nix|dockerfile|compose\.ya?ml)$/i;
const SYSTEMS_PATH = /(^|\/)(compiler|parser|runtime|kernel|database|storage|distributed|consensus|network|protocol|vm|wasm|cuda|gpu|firmware|embedded|crypto|cryptography)(\/|[._-])/i;
const RESEARCH_PATH = /(^|\/)(papers?|research|experiments?|notebooks?|models?|datasets?|simulations?)(\/|$)|\.(ipynb|bib|tex)$/i;

function extension(path: string) {
  return path.toLowerCase().split(".").pop() ?? "";
}

function entropy(values: number[]) {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!total || values.length <= 1) return values.length === 1 ? 0.2 : 0;
  const raw = values.reduce((sum, value) => {
    const share = value / total;
    return sum - share * Math.log(share);
  }, 0);
  return clamp(raw / Math.log(Math.min(8, values.length)));
}

export function analyzeRepositoryInventory(input: {
  tree: RepositoryTreeEntry[];
  languages?: Record<string, number>;
  contributors?: RepositoryContributor[];
  commitCountSample?: number;
  releaseCountSample?: number;
  stars?: number;
  forks?: number;
  description?: string | null;
  hardConstraintKeywords?: string[];
  treeTruncated?: boolean;
  evidenceCoverage?: number;
}): RepositoryComplexityAnalysis {
  const blobs = input.tree.filter((entry) => entry.type === "blob");
  const sourceFiles = blobs.filter((entry) => SOURCE_EXTENSIONS.has(extension(entry.path)));
  const vendoredSource = sourceFiles.filter((entry) => VENDORED_PATH.test(entry.path));
  const authoredSource = sourceFiles.filter((entry) => !VENDORED_PATH.test(entry.path));
  const totalAuthoredBytes = authoredSource.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
  const sourceSurface = clamp(
    Math.log1p(authoredSource.length) / Math.log(401) * 0.65 +
      Math.log1p(totalAuthoredBytes) / Math.log(20_000_001) * 0.35,
  );
  const languageBytes = Object.values(input.languages ?? {}).filter((value) => value > 0);
  const languageBreadth = clamp(
    entropy(languageBytes) * 0.7 + Math.min(1, languageBytes.length / 5) * 0.3,
  );
  const testCount = blobs.filter((entry) => TEST_PATH.test(entry.path)).length;
  const ciCount = blobs.filter((entry) => CI_PATH.test(entry.path)).length;
  const manifestCount = blobs.filter((entry) => MANIFEST_PATH.test(entry.path)).length;
  const testsAndCi = clamp(
    Math.min(0.55, Math.log1p(testCount) / 7) +
      Math.min(0.25, ciCount * 0.12) +
      Math.min(0.2, manifestCount * 0.04),
  );
  const systemsCount = blobs.filter((entry) => SYSTEMS_PATH.test(entry.path)).length;
  const researchCount = blobs.filter((entry) => RESEARCH_PATH.test(entry.path)).length;
  const systemsAndResearch = clamp(
    Math.log1p(systemsCount) / 6 * 0.55 + Math.log1p(researchCount) / 6 * 0.45,
  );
  const authoredCodeRatio = sourceFiles.length
    ? clamp(1 - vendoredSource.length / sourceFiles.length)
    : 0;
  const historyDepth = clamp(
    Math.min(0.72, (input.commitCountSample ?? 0) / 70) +
      Math.min(0.28, (input.releaseCountSample ?? 0) / 12),
  );
  const contributions = (input.contributors ?? [])
    .map((contributor) => contributor.contributions)
    .filter((value) => value > 0);
  const totalContributions = contributions.reduce((sum, value) => sum + value, 0);
  const concentration = totalContributions ? Math.max(...contributions) / totalContributions : 1;
  const contributorShape = clamp(
    contributions.length === 1
      ? 0.65
      : Math.min(0.75, contributions.length / 8) + (1 - concentration) * 0.25,
  );
  const docsCount = blobs.filter((entry) => DOC_PATH.test(entry.path)).length;
  const benchmarkCount = blobs.filter((entry) => BENCHMARK_PATH.test(entry.path)).length;
  const documentationAndBenchmarks = clamp(
    Math.min(0.55, Math.log1p(docsCount) / 6) +
      Math.min(0.45, Math.log1p(benchmarkCount) / 4),
  );
  const corpus = `${input.description ?? ""}\n${blobs.map((entry) => entry.path).join("\n")}`.toLowerCase();
  const matchedKeywords = (input.hardConstraintKeywords ?? [])
    .map((keyword) => keyword.trim().toLowerCase())
    .filter((keyword) => keyword && corpus.includes(keyword));
  const hardConstraintMatch = input.hardConstraintKeywords?.length
    ? clamp(matchedKeywords.length / Math.min(4, input.hardConstraintKeywords.length))
    : 0;
  // Popularity is deliberately capped at three percent of this analysis.
  const tractionCorroboration = clamp(
    (Math.log1p(input.stars ?? 0) + Math.log1p(input.forks ?? 0)) / 20,
  );
  const rawScore = clamp(
    sourceSurface * 0.2 +
      languageBreadth * 0.1 +
      testsAndCi * 0.15 +
      systemsAndResearch * 0.16 +
      authoredCodeRatio * 0.1 +
      historyDepth * 0.1 +
      contributorShape * 0.06 +
      documentationAndBenchmarks * 0.08 +
      hardConstraintMatch * 0.02 +
      tractionCorroboration * 0.03,
  );
  const score = clamp(
    rawScore *
      ((input.hardConstraintKeywords?.length ?? 0) > 0 && matchedKeywords.length === 0
        ? 0.72
        : 1),
  );
  const coverage = input.evidenceCoverage ?? 1;
  const confidence = clamp(
    coverage *
      (input.treeTruncated ? 0.62 : 0.9) *
      (languageBytes.length ? 1 : 0.78) *
      (input.commitCountSample !== undefined ? 1 : 0.86),
  );
  const indicators: string[] = [];
  if (sourceSurface >= 0.55) indicators.push("substantial authored-code surface");
  if (languageBreadth >= 0.5) indicators.push("multi-language implementation");
  if (testCount) indicators.push(`${testCount} test or specification files`);
  if (ciCount) indicators.push("continuous-integration configuration");
  if (systemsCount) indicators.push("systems-level implementation structure");
  if (researchCount) indicators.push("research or experimental artifacts");
  if (benchmarkCount) indicators.push("benchmarks or evaluation assets");
  if (matchedKeywords.length) indicators.push(`constraint matches: ${matchedKeywords.join(", ")}`);
  return {
    score,
    confidence,
    components: {
      sourceSurface,
      languageBreadth,
      testsAndCi,
      systemsAndResearch,
      authoredCodeRatio,
      historyDepth,
      contributorShape,
      documentationAndBenchmarks,
      hardConstraintMatch,
      tractionCorroboration,
    },
    indicators,
    evidence: [
      `${authoredSource.length} authored source files observed`,
      `${vendoredSource.length} vendored/generated source files excluded`,
      `${languageBytes.length} implementation languages reported`,
      `${input.commitCountSample ?? 0} recent commits sampled`,
      `${input.releaseCountSample ?? 0} releases sampled`,
      `${contributions.length} contributors sampled`,
      ...(input.treeTruncated ? ["Repository tree was truncated; confidence reduced"] : []),
    ],
  };
}

type GitHubTreeResponse = { tree?: RepositoryTreeEntry[]; truncated?: boolean };
type GitHubContributor = { contributions?: number };

export async function analyzeGitHubRepositoryComplexity(input: {
  owner: string;
  repo: string;
  defaultBranch: string;
  stars?: number;
  forks?: number;
  description?: string | null;
  hardConstraintKeywords?: string[];
  headers: HeadersInit;
  signal?: AbortSignal;
}): Promise<RepositoryComplexityAnalysis> {
  const base = `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`;
  const [tree, languages, contributors, commits, releases] = await Promise.all([
    fetchJson<GitHubTreeResponse>(
      `${base}/git/trees/${encodeURIComponent(input.defaultBranch)}?recursive=1`,
      { headers: input.headers, signal: input.signal, rateLimitPerSecond: 4, maxBytes: 12_000_000 },
    ),
    fetchJson<Record<string, number>>(`${base}/languages`, {
      headers: input.headers,
      signal: input.signal,
      rateLimitPerSecond: 4,
    }).catch(() => ({})),
    fetchJson<GitHubContributor[]>(`${base}/contributors?per_page=100&anon=1`, {
      headers: input.headers,
      signal: input.signal,
      rateLimitPerSecond: 4,
    }).catch(() => []),
    fetchJson<unknown[]>(`${base}/commits?per_page=100`, {
      headers: input.headers,
      signal: input.signal,
      rateLimitPerSecond: 4,
    }).catch(() => []),
    fetchJson<unknown[]>(`${base}/releases?per_page=30`, {
      headers: input.headers,
      signal: input.signal,
      rateLimitPerSecond: 4,
    }).catch(() => []),
  ]);
  return analyzeRepositoryInventory({
    tree: tree.tree ?? [],
    treeTruncated: tree.truncated,
    languages,
    contributors: contributors.map((item) => ({ contributions: item.contributions ?? 0 })),
    commitCountSample: commits.length,
    releaseCountSample: releases.length,
    stars: input.stars,
    forks: input.forks,
    description: input.description,
    hardConstraintKeywords: input.hardConstraintKeywords,
  });
}

export async function analyzeTopGitHubRepositories<T>(input: {
  repositories: T[];
  limit?: number;
  analyze: (repository: T) => Promise<RepositoryComplexityAnalysis>;
}) {
  return mapLimit(input.repositories.slice(0, input.limit ?? 4), 2, input.analyze);
}
