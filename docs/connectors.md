# Connector inventory and source compliance

Unfound uses source-specific connectors behind a shared discovery contract. A connector emits attributable events and person observations; it does not decide that two observations are the same human.

## Implemented adapters

| Source | Discovery | Enrichment | Graph expansion | Credential | Primary signals |
| --- | --- | --- | --- | --- | --- |
| GitHub | Repository search | User profile and recent repositories | Public following graph | `GITHUB_TOKEN` recommended | New projects, releases, momentum, open-source identity |
| GitLab | Public project search | User profile and projects | Not implemented | `GITLAB_TOKEN` optional | Independent projects, recent activity, open source |
| OpenAlex | Recent works by topic | Works by author | Co-authorship | `OPENALEX_EMAIL` recommended | Research output, affiliations, co-author graph |
| Crossref | Recent works by query | Not implemented | Not implemented | `CROSSREF_EMAIL` recommended | DOI-backed publications and citation metadata |
| arXiv | Recent submissions by category/query | Not implemented | Not implemented | None | Early research, preprints, author evidence |
| Semantic Scholar | Paper search | Papers by resolved author | Not implemented | `SEMANTIC_SCHOLAR_API_KEY` recommended | Research topics, citations, influential citations |
| Codeforces | Recent contest standings | Public profile and rating history | Not implemented | None | Competition placements, rating trajectory |
| Hacker News | New, best, top, or Show stories | Public user and submissions | Not implemented | None | Builder launches and community recognition |
| RSS / Atom | Reviewer-configured feeds | Not implemented | Not implemented | None | Personal sites, lab updates, accelerator and organizer feeds |
| Technical blogs / launch feeds | Reviewer-configured RSS/Atom feeds | Not implemented | Not implemented | None | Technical writing, project launches, repository releases |
| Personal web presence | Reviewer-configured site, sitemap, or feed | Publisher-page JSON-LD/main-text verification | Not implemented | None | Authored posts, projects, personal-site identity evidence |
| Structured results | Allowlisted result pages with source-specific selectors | Not implemented | Not implemented | None | Olympiads, competitions, fellowships, hackathons |
| Brave Search | Never used for broad discovery | Post-candidate URL location followed by publisher-page verification | Not implemented | `BRAVE_SEARCH_API_KEY` required | Public pages missed by source-specific connectors |
| X official API | Configured recent-search queries | Public profile and recent original posts | Public following graph | `X_BEARER_TOKEN` required | Seed graph, repeated public engagement, recent builder signals |
| LinkedIn manual | Reviewer/approved-integration payload | Not implemented | Not implemented | None | Manually supplied profile evidence; never fetches LinkedIn |

“Implemented” means an adapter exists in `lib/discovery/connectors`. A source is called only when it is registered and enabled in dashboard source settings. Credential-free APIs still enforce conservative request budgets.

GitHub, GitLab, OpenAlex, Crossref, arXiv, Semantic Scholar, Codeforces, Hacker News, and candidate-driven personal-site enrichment have conservative enabled defaults. Direct personal-site discovery still requires configured URLs. RSS, technical blogs, launch feeds, structured result pages, X, Brave enrichment, and manual LinkedIn remain disabled until their required URLs, definitions, queries, or credentials are supplied.

## Deliberately constrained sources

| Source family | Default behavior | Reason |
| --- | --- | --- |
| LinkedIn | Implemented as user-supplied/approved-integration payload only; the adapter performs no network request | Unauthorized automated scraping and profile copying are prohibited; “first profile creation” is not a reliable public event |
| X | Adapter remains inert without a read-only official API bearer token and configured queries | Social graph collection is policy-sensitive and rate-limited; public HTML scraping is not a substitute for API access |
| Competition and olympiad sites | Allowlisted, source-specific structured-results definitions | Result formats, terms, and age/minor exposure differ by organizer |
| Hackathon platforms | Official APIs/feeds when available; otherwise allowlisted public result pages | Avoid account crawling and collection of irrelevant participant data |
| Personal sites and RSS | Reviewer-added feeds with `robots.txt` checks | Broad search-index crawling would be noisy and difficult to govern |
| Search providers | Post-candidate location of public source URLs; retrieved publisher pages still pass robots, pacing, size, redirect, content, and SSRF checks | Search results are pointers, not evidence by themselves |

Useful compliant proxies for “a new person appeared online” include first public repository activity, first research author profile, first personal site/RSS item, first competition result, or first institutional bio. Do not claim these prove when a LinkedIn account was created.

## Connector configuration

All adapters consume the same bounded settings shape:

```ts
type ConnectorSettings = {
  enabled: boolean
  queries?: string[]
  seedIds?: string[]
  urls?: string[]
  maxItems?: number
  lookbackDays?: number
  options?: Record<string, unknown>
}
```

Examples of source-specific options:

```json
{
  "github": {
    "enabled": true,
    "queries": [
      "pushed:>=2026-06-01 stars:>=10 language:Rust",
      "created:>=2026-06-01 topic:robotics"
    ],
    "lookbackDays": 21,
    "maxItems": 50
  },
  "codeforces": {
    "enabled": true,
    "maxItems": 30,
    "options": { "maxContests": 2 }
  },
  "hacker-news": {
    "enabled": true,
    "maxItems": 40,
    "options": { "feed": "showstories", "minimumScore": 3 }
  }
}
```

Settings are server-validated and capped again inside each connector. A dashboard value cannot remove a hard safety cap.

`DISCOVERY_CONNECTOR_CONFIG` may provide a JSON override for development or controlled deployment, but persisted dashboard settings are easier to audit. Do not place manual profile payloads or other personal data in environment variables.

## Credentials and least privilege

- `GITHUB_TOKEN`: use a fine-grained read-only token. Do not grant private-repository access.
- `GITLAB_TOKEN`: use `read_api` only and a service account with no private group membership when possible.
- `SEMANTIC_SCHOLAR_API_KEY`: use a dedicated project key; the adapter falls back to a slower unauthenticated budget.
- `OPENALEX_EMAIL` and `CROSSREF_EMAIL`: identify the application for polite-pool access. Use a monitored team alias.
- `X_BEARER_TOKEN`: when an X connector is enabled, use an application-only read credential and only requested public fields.
- `BRAVE_SEARCH_API_KEY`: enables at most two bounded queries for an already-created candidate. Brave results remain transient locators. The connector stores only normalized URL/query-hash metadata and evidence independently extracted from the publisher page; it never stores Brave snippets or result bodies. `BRAVE_SEARCH_STORAGE_ALLOWED=false` documents the required default and should remain false unless a future implementation and plan explicitly grant storage rights.

All credentials are server-only. Do not prefix them with `NEXT_PUBLIC_`, store them in candidate records, return them from route handlers, or include them in LLM prompts.

## Shared network controls

`lib/discovery/http.ts` provides the minimum controls every HTTP connector should use:

- reject non-HTTP(S), credentials in URLs, localhost, link-local, private, loopback, multicast, and reserved network destinations;
- re-check every redirect target to limit SSRF and DNS-rebinding exposure;
- apply request timeouts, response-size limits, per-origin pacing, and bounded retries;
- honor `Retry-After` within a maximum delay;
- fetch and cache `robots.txt` rules and apply declared crawl delays for page connectors;
- use a descriptive user agent;
- return source-scoped warnings instead of crashing the full discovery run.

An allowlist is still preferred for structured-result and RSS connectors. Network validation is defense in depth, not permission to crawl an arbitrary URL.

## Source onboarding checklist

Before adding or enabling a source:

1. Read its current terms, API policy, robots rules, redistribution limits, and retention requirements.
2. Confirm the intended fields are public and relevant to scouting.
3. Prefer an official API, data export, RSS/Atom feed, or organizer-published result file.
4. Define a stable external ID, source URL, occurred-at timestamp, and confidence behavior.
5. Add hard limits for lookback, results, pages, payload bytes, and graph fan-out.
6. Decide what raw payload is necessary and set a deletion/refresh policy.
7. Test redirects, 429s, malformed payloads, removed records, and same-name collisions.
8. Add connector-specific attribution and correction handling.
9. Confirm minors are not enriched beyond the relevant public achievement.
10. Start disabled, observe warnings and precision, then enable for the smallest useful cohort.

## Adding a connector

Implement `DiscoveryConnector` and keep source parsing inside its adapter. Emit normalized events through `createDiscoveryEvent`, use the shared HTTP client, and do not write directly to candidate tables. Register it in the connector registry, add dashboard defaults, document credentials here and in `.env.example`, and run fixture tests before live requests.

Graph methods must return an evidence URL for every edge. A relationship inferred only from an LLM is not a graph edge.

## Compliance references

- [GitHub REST API terms](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features#api-terms)
- [OpenAlex API](https://docs.openalex.org/how-to-use-the-api/api-overview)
- [Crossref REST API etiquette](https://www.crossref.org/documentation/retrieve-metadata/rest-api/rest-api-metadata-retrieval/)
- [arXiv API user manual](https://info.arxiv.org/help/api/user-manual.html)
- [Semantic Scholar API](https://www.semanticscholar.org/product/api)
- [LinkedIn User Agreement](https://www.linkedin.com/legal/user-agreement)
- [LinkedIn API Terms](https://www.linkedin.com/legal/l/api-terms-of-use)

Terms change. Re-check them before production enablement and record the review date in source settings.
