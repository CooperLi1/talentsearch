# Connector inventory and source compliance

Unfound uses source-specific connectors behind a shared discovery contract. A connector emits attributable events and person observations; it does not decide that two observations are the same human.

## Implemented adapters

| Source | Discovery | Enrichment | Graph expansion | Credential | Primary signals |
| --- | --- | --- | --- | --- | --- |
| GitHub | Repository search | User profile and recent repositories | Public following graph | `GITHUB_TOKEN` recommended | New projects, releases, momentum, open-source identity |
| GitLab | Public project search | User profile and projects | Not implemented | `GITLAB_TOKEN` optional | Independent projects, recent activity, open source |
| OpenAlex | Recent works by topic | Works by author | Co-authorship | `OPENALEX_API_KEY` required | Research output, affiliations, co-author graph |
| Crossref | Recent works by query | Not implemented | Not implemented | `CROSSREF_EMAIL` recommended | DOI-backed publications and citation metadata |
| arXiv | Recent submissions by category/query | Not implemented | Not implemented | None | Early research, preprints, author evidence |
| Semantic Scholar | Paper search | Papers by resolved author | Not implemented | `SEMANTIC_SCHOLAR_API_KEY` recommended | Research topics, citations, influential citations |
| Hugging Face Hub | Rotating public model, dataset, and Space search | Public user verification during discovery | Not implemented | `HF_TOKEN` optional | Public ML artifacts, reusable datasets, working demos, metadata-only technical depth |
| Codeforces | Recent contest standings | Public profile and rating history | Not implemented | None | Competition placements, rating trajectory |
| Hacker News | New, best, top, or Show stories | Public user and submissions | Not implemented | None | First-person Show HN launches and low-confidence graph leads |
| RSS / Atom | Reviewer-configured feeds | Not implemented | Not implemented | None | Personal sites, lab updates, accelerator and organizer feeds |
| Technical blogs / launch feeds | Reviewer-configured RSS/Atom feeds | Not implemented | Not implemented | None | Technical writing, project launches, repository releases |
| Personal web presence | Reviewer-configured site, sitemap, or feed | Publisher-page JSON-LD/main-text verification | Not implemented | None | Authored posts, projects, personal-site identity evidence |
| Structured results | Allowlisted result pages with source-specific selectors | Not implemented | Not implemented | None | Olympiads, competitions, fellowships, hackathons |
| Brave Search | Never used for broad discovery | Post-candidate URL location followed by publisher-page verification | Not implemented | `BRAVE_SEARCH_API_KEY` required | Public pages missed by source-specific connectors |
| X official API | Configured recent-search queries | Public profile and recent original posts | Public following graph | `X_BEARER_TOKEN` required | Seed graph, repeated public engagement, recent builder signals |
| LinkedIn reviewed/approved | Operator-confirmed member URL, candidate-owned site link, or public provider-bio link | LinkedIn URLs may be located by Brave; separately approved profile access can resolve exact URLs | Operator confirmation or approved durable member subject | Approved product/partner access for API mode | The connector never opens or copies LinkedIn pages |

“Implemented” means an adapter exists in `lib/discovery/connectors`. A source is called only when it is registered and enabled in dashboard source settings. Credential-free APIs still enforce conservative request budgets.

GitHub, GitLab, Crossref, arXiv, Semantic Scholar, Codeforces, Hacker News, five verified technical feeds, one official IMO results page, and candidate-driven personal-site enrichment have conservative enabled defaults. Hacker News link submissions remain useful graph observations, but count as a candidate's work only when a Show HN body explicitly attributes the work to the submitter in the first person. OpenAlex ships with recommended topics but stays disabled until `OPENALEX_API_KEY` is configured. Hugging Face ships disabled until an operator reviews its identity quality and enables it. Direct personal-site discovery still requires configured URLs. Additional feeds and result pages, science fairs, hackathon showcases, X, Brave enrichment, and manual LinkedIn remain disabled until their required URLs, definitions, queries, or credentials are supplied.

## Deliberately constrained sources

| Source family | Default behavior | Reason |
| --- | --- | --- |
| LinkedIn | Operator-reviewed URL import by default; an explicit approved endpoint can return permitted profile fields and a durable member subject | The app never requests LinkedIn HTML. Unauthorized scraping, authenticated-browser automation, and profile copying are prohibited; “first profile creation” is not a reliable public event |
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
    "queries": ["compiler", "database", "robotics"],
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

Settings are server-validated and capped again inside each connector. At most eight saved queries run per query-driven source. GitHub adds a rolling `pushed` qualifier when a query does not already contain `pushed:` or `created:`; GitLab sends `last_activity_after`. Stored topic queries therefore remain readable while `lookbackDays` continues to bound every run. Hacker News topic keywords prioritize matching Show HN stories but do not exclude novel off-topic work unless `requireTopicMatch` is explicitly enabled. A dashboard value cannot remove a hard safety cap.

### Recommended topic coverage

The bootstrap uses the same eight-domain research set for OpenAlex, Crossref, and Semantic Scholar: machine-learning systems; robot learning and autonomous systems; computer security and applied cryptography; programming languages and formal methods; distributed systems and databases; computational biology and bioengineering; scientific computing and simulation; and human-computer interaction and assistive technology.

Repository discovery uses narrower search terms because provider repository search is lexical:

- GitHub: compiler, database, robotics, inference engine, cryptography, bioinformatics, embedded systems, developer tools. Each default also uses `stars:<300 size:>20` to suppress already-famous and empty repositories without requiring traction.
- GitLab: compiler, database, robotics, inference, cryptography, bioinformatics, scientific computing, developer tools.
- arXiv: `cs.AI OR cs.LG`, `cs.RO`, `cs.CR`, `cs.DC OR cs.OS`, `cs.PL OR cs.SE`, `cs.AR`, `q-bio.QM OR q-bio.BM`, and `physics.comp-ph OR eess.SY`.
- X, when explicitly connected: original build/open-source posts in systems, robotics, hardware, and ML; new papers; competition results; and first-release/contributor calls.

GitHub and GitLab enrichment also use a 30-term technical-depth vocabulary spanning compilers, storage engines, distributed systems, runtimes, kernels, protocols, cryptography, formal verification, robotics and firmware, simulation, scientific computing, bioinformatics, ML infrastructure, observability, static analysis, networking, scheduling, and query optimization. This vocabulary is only one small part of structural repository analysis; it never substitutes for inspectable code, tests, history, and benchmarks.

### Verified starter sources

Fresh workspaces enable nine author-attributed technical feeds: GitHub Blog, Mozilla Hacks, Cloudflare Blog, Google Project Zero, GitLab Blog, Slack Engineering, Memfault Interrupt, Embedded Artistry, and the Rust Blog. Each feed returned HTTP 200 and usable entry-level author fields when verified on July 12, 2026. They are starter coverage, not a general web crawl, and operators can remove or replace any URL.

The official 2025 International Mathematical Olympiad and International Chemistry Olympiad individual-results tables are enabled with source-specific selectors and official completion dates. The combined run is capped at 100 ranked rows. The official Regeneron Science Talent Search 2026 finalist showcase and Hertz Fellowship 2026 cohort are separate reviewed sources with exact announcement dates and profile links. Hertz requests must honor the site's ten-second crawl delay.

IOI is deliberately not seeded because its `robots.txt` disallows `/results`. ISEF award releases and Breakthrough Junior Challenge are not seeded because their current markup cannot reliably bind a clean person name to one project or award with the generic parser. No generic personal-site or “young builder” list is added automatically.

`DISCOVERY_CONNECTOR_CONFIG` may provide a JSON override for development or controlled deployment, but persisted dashboard settings are easier to audit. Do not place manual profile payloads or other personal data in environment variables.

## Credentials and least privilege

- `GITHUB_TOKEN`: use a fine-grained read-only token. Do not grant private-repository access.
- `GITLAB_TOKEN`: optional for read-only enrichment. Global discovery remains anonymous and public-only; enrichment filters projects to public visibility and retries anonymously after a token permission denial.
- `SEMANTIC_SCHOLAR_API_KEY`: use a dedicated project key; the adapter falls back to a slower unauthenticated budget.
- `HF_TOKEN`: optional read-only Hub token. Discovery uses official public list and user-overview endpoints only. The connector never downloads or executes model weights, datasets, repositories, or Space code.
- `OPENALEX_API_KEY`: required for OpenAlex. The free key belongs in server-only environment settings and is sent through the `api_key` query parameter. OpenAlex's free daily allowance is still protected by the connector's request and result caps.
- `OPENALEX_EMAIL`: optional legacy attribution. OpenAlex has ignored `mailto` since February 2026; it is not authentication.
- `CROSSREF_EMAIL`: identifies the application for Crossref polite-pool access. Use a monitored team alias.
- `X_BEARER_TOKEN`: use an application-only read credential and only requested public fields. Keep `X_DATA_USE_APPROVED=false` until X has approved the disclosed cross-platform research use and the required retention/deletion controls are operational; the connector remains inert otherwise.
- `BRAVE_SEARCH_API_KEY`: enables up to five bounded follow-up queries for an already-created candidate and up to twelve publisher pages per query. Three research passes rotate through identity/homepage discovery, work and third-party mentions, then aliases, collaborators, and cross-account matching. Brave results remain transient locators. A page is candidate-bound only through exact author identity, a verified known domain, an exact linked project or provider profile, or name plus affiliation; a handle appearing in prose is not enough. The connector stores only normalized URL/query-hash metadata and evidence independently extracted from the publisher page; it never stores Brave snippets or result bodies. `BRAVE_SEARCH_STORAGE_ALLOWED=false` documents the required default and should remain false unless a future implementation and plan explicitly grant storage rights.
- LinkedIn profile URLs found on candidate-owned sites or readable public provider bios are carried as identity hypotheses with their publisher-page provenance. A single unambiguous URL returned by Brave may also be carried as an unverified locator, but only alongside independently fetched public-page evidence for the candidate. It is never an evidence link and must be reviewed by an operator before the manual source ingests it.
- `LINKEDIN_DIRECT_ACCESS_APPROVED` must remain `false` unless LinkedIn has separately approved the application's member-data use. An approved integration also needs `LINKEDIN_APPROVED_API_BASE_URL` and `LINKEDIN_APPROVED_API_TOKEN`; all three settings are required and remain server-only. The configured HTTPS endpoint receives a `profileUrl` query parameter and must return JSON shaped as `{ memberId, profileUrl, name, headline?, biography?, location?, affiliations?, websiteUrl?, alternateNames? }`. The connector rejects responses that omit a durable member ID or return a different normalized `/in/...` URL. This endpoint can be an approved partner gateway because LinkedIn products expose different contracts and permissions. It never authorizes page scraping or authenticated browser automation.

### Connecting LinkedIn

The default workflow does not require a LinkedIn developer token:

1. Enable **Public web enrichment** in Sources so the app can locate candidate-owned sites, public bios, and possible LinkedIn profile URLs.
2. Open **LinkedIn approved import** in Sources, add the person's public `/in/...` profile URL and the public page where the match was established, then check the identity confirmation.
3. Save the profile and choose **Include in scans**. The next scan binds the reviewed URL to the candidate and uses only the context entered by the operator or found on permitted publisher pages.

LinkedIn does not offer general self-serve access to arbitrary member profiles. A direct integration requires separately approved LinkedIn product or partner access and must use only the fields and retention terms granted to that application. Once approved, configure the three server-only settings above and enable the LinkedIn source; candidates with a discovered or reviewed LinkedIn URL will be resolved through that approved endpoint. Until that approval exists, do not put session cookies, browser credentials, or scraped LinkedIn HTML into the app.

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
- [OpenAlex authentication](https://developers.openalex.org/api-reference/authentication)
- [Crossref REST API etiquette](https://www.crossref.org/documentation/retrieve-metadata/rest-api/rest-api-metadata-retrieval/)
- [arXiv API user manual](https://info.arxiv.org/help/api/user-manual.html)
- [Semantic Scholar API](https://www.semanticscholar.org/product/api)
- [LinkedIn User Agreement](https://www.linkedin.com/legal/user-agreement)
- [LinkedIn API Terms](https://www.linkedin.com/legal/l/api-terms-of-use)

Terms change. Re-check them before production enablement and record the review date in source settings.
