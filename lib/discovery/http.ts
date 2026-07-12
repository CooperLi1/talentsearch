import { assertPublicHttpUrl } from "./security";

const DEFAULT_USER_AGENT =
  "Unfound/1.0 (+https://github.com; evidence-first public-interest crawler)";
const ROBOTS_TTL_MS = 6 * 60 * 60 * 1_000;

type RobotsRules = {
  fetchedAt: number;
  allow: string[];
  disallow: string[];
  crawlDelayMs: number;
};

type SmartFetchOptions = RequestInit & {
  respectRobots?: boolean;
  timeoutMs?: number;
  retries?: number;
  maxBytes?: number;
  rateLimitPerSecond?: number;
  userAgent?: string;
};

const robotsCache = new Map<string, RobotsRules>();
const originGates = new Map<string, Promise<void>>();
const originLastRequest = new Map<string, number>();

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(signal.reason ?? new Error("Request aborted"));
      },
      { once: true },
    );
  });
}

async function waitForOrigin(
  origin: string,
  requestsPerSecond: number,
  signal?: AbortSignal,
) {
  const previous = originGates.get(origin) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  originGates.set(origin, queued);

  await previous;
  try {
    const minimumGap = Math.ceil(1_000 / Math.max(0.1, requestsPerSecond));
    const waitMs = Math.max(
      0,
      (originLastRequest.get(origin) ?? 0) + minimumGap - Date.now(),
    );
    if (waitMs) await sleep(waitMs, signal);
    originLastRequest.set(origin, Date.now());
  } finally {
    release?.();
    if (originGates.get(origin) === queued) originGates.delete(origin);
  }
}

function parseRobots(contents: string, userAgent: string): RobotsRules {
  const groups: Array<{ agents: string[]; allow: string[]; disallow: string[]; crawlDelayMs: number }> = [];
  let current: { agents: string[]; allow: string[]; disallow: string[]; crawlDelayMs: number } | null = null;

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (field === "user-agent") {
      if (!current || current.allow.length || current.disallow.length) {
        current = { agents: [], allow: [], disallow: [], crawlDelayMs: 0 };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if (current && field === "allow") {
      current.allow.push(value);
    } else if (current && field === "disallow" && value) {
      current.disallow.push(value);
    } else if (current && field === "crawl-delay") {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds > 0) current.crawlDelayMs = Math.min(60_000, seconds * 1_000);
    }
  }

  const normalizedAgent = userAgent.toLowerCase().split(/[\s/]/)[0];
  const matching = groups.filter((group) =>
    group.agents.some(
      (agent) => agent === "*" || normalizedAgent.includes(agent),
    ),
  );
  const specific = matching.filter((group) =>
    group.agents.some((agent) => agent !== "*"),
  );
  const selected = specific.length ? specific : matching;

  return {
    fetchedAt: Date.now(),
    allow: selected.flatMap((group) => group.allow),
    disallow: selected.flatMap((group) => group.disallow),
    crawlDelayMs: Math.max(0, ...selected.map((group) => group.crawlDelayMs)),
  };
}

function pathMatches(rule: string, pathname: string): boolean {
  if (!rule) return false;
  const escaped = rule
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\$$/, "$");
  return new RegExp(`^${escaped}`).test(pathname);
}

async function robotsPolicy(url: URL, userAgent: string): Promise<{ allowed: boolean; crawlDelayMs: number }> {
  const cached = robotsCache.get(url.origin);
  let rules = cached;
  if (!rules || Date.now() - rules.fetchedAt > ROBOTS_TTL_MS) {
    try {
      const robotsUrl = `${url.origin}/robots.txt`;
      const response = await fetch(robotsUrl, {
        headers: { "user-agent": userAgent },
        redirect: "manual",
        signal: AbortSignal.timeout(5_000),
      });
      rules = response.ok
        ? parseRobots((await response.text()).slice(0, 512_000), userAgent)
        : { fetchedAt: Date.now(), allow: [], disallow: [], crawlDelayMs: 0 };
    } catch {
      // A missing/unreachable robots file is treated as no declared restriction.
      rules = { fetchedAt: Date.now(), allow: [], disallow: [], crawlDelayMs: 0 };
    }
    robotsCache.set(url.origin, rules);
  }

  const path = `${url.pathname}${url.search}`;
  const matches = [
    ...rules.allow.map((rule) => ({ rule, allowed: true })),
    ...rules.disallow.map((rule) => ({ rule, allowed: false })),
  ]
    .filter(({ rule }) => pathMatches(rule, path))
    .sort((a, b) => b.rule.length - a.rule.length);

  return { allowed: matches[0]?.allowed ?? true, crawlDelayMs: rules.crawlDelayMs };
}

async function limitedResponse(response: Response, maxBytes: number) {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > maxBytes) {
    throw new Error(`Response exceeds ${maxBytes} byte limit`);
  }
  if (!response.body) return response;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Response exceeds ${maxBytes} byte limit`);
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export async function smartFetch(
  input: string,
  options: SmartFetchOptions = {},
): Promise<Response> {
  const {
    respectRobots = false,
    timeoutMs = 12_000,
    retries = 2,
    maxBytes = 5_000_000,
    rateLimitPerSecond = 2,
    userAgent = DEFAULT_USER_AGENT,
    headers,
    signal,
    ...init
  } = options;

  let url = await assertPublicHttpUrl(input);
  let policy = respectRobots ? await robotsPolicy(url, userAgent) : { allowed: true, crawlDelayMs: 0 };
  if (!policy.allowed) {
    throw new Error(`robots.txt disallows ${url.pathname}`);
  }

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const robotsRate = policy.crawlDelayMs > 0 ? 1_000 / policy.crawlDelayMs : rateLimitPerSecond;
      await waitForOrigin(url.origin, Math.min(rateLimitPerSecond, robotsRate), signal ?? undefined);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const forwardAbort = () => controller.abort(signal?.reason);
      signal?.addEventListener("abort", forwardAbort, { once: true });

      let response: Response;
      try {
        response = await fetch(url, {
          ...init,
          headers: {
            accept: "application/json, application/atom+xml, application/rss+xml, text/html;q=0.9, */*;q=0.5",
            "user-agent": userAgent,
            ...headers,
          },
          redirect: "manual",
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", forwardAbort);
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new Error("Redirect response had no location");
        url = await assertPublicHttpUrl(new URL(location, url).toString());
        policy = respectRobots ? await robotsPolicy(url, userAgent) : policy;
        if (!policy.allowed) {
          throw new Error(`robots.txt disallows redirected path ${url.pathname}`);
        }
        continue;
      }

      if (response.status === 429 || response.status >= 500) {
        if (attempt >= retries) return limitedResponse(response, maxBytes);
        const retryAfter = Number(response.headers.get("retry-after"));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1_000, 30_000)
          : Math.min(500 * 2 ** attempt + Math.random() * 250, 10_000);
        await sleep(delay, signal ?? undefined);
        continue;
      }

      return limitedResponse(response, maxBytes);
    } catch (error) {
      lastError = error;
      if (attempt >= retries || signal?.aborted) break;
      await sleep(Math.min(400 * 2 ** attempt + Math.random() * 200, 5_000), signal ?? undefined);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Fetch failed");
}

export async function fetchJson<T>(
  url: string,
  options?: SmartFetchOptions,
): Promise<T> {
  const response = await smartFetch(url, options);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
  }
  return (await response.json()) as T;
}
