# Reusable lessons

## Keep external clients lazy

Next.js may evaluate imported server modules during builds, previews, and static analysis before runtime secrets exist. Initialize Resend, Supabase service-role, and other secret-dependent SDKs inside cached getter functions, not at module scope. This preserves build safety and makes explicit preview mode possible without weakening production validation.

## Idempotency has a retention boundary

Provider idempotency is not durable workflow state. Resend batch keys expire after 24 hours, and Vercel cron can miss or duplicate an invocation without retrying failures. A durable digest key, frozen payload, atomic database claim, and retry window shorter than provider retention stop concurrent or late replays. A complete retry-safe design must also freeze the recipient cohort, persist per-recipient/provider delivery state, and reconcile from the database before every retry. Until those recipient snapshots exist, keep recipient configuration stable across retries.

## Similar names are a review state, not a merge signal

Fuzzy name matching should generate identity candidates only. Automatic matches require a verified provider identity or agreement across independent attributes such as ORCID, canonical website, affiliation, project, or co-author. Preserving two unresolved people is cheaper to repair than contaminating both timelines, embeddings, graph edges, and emails with a false merge.

## Email-safe design is its own medium

Web motion and modern layout rules do not transfer directly to inboxes. Preserve the visual concept through strong hierarchy, sequencing, contrast, and table-based responsive structure; do not ship JavaScript, depend on CSS grid, or load candidate avatars from arbitrary source hosts. Remote profile images can disclose a recipient’s IP to a third party when the message opens.

## A search result is a locator, not evidence

Search snippets can be stale, misattributed, truncated, or contractually restricted from storage. Use them only to locate a public publisher page, then re-validate that URL through SSRF and robots controls and derive claims from the fetched page. Persist a content hash, canonical URL, retrieval time, and query hash—not the search response—unless the provider plan explicitly grants storage rights.

## Repository popularity is not technical depth

Stars and forks measure distribution as much as engineering. Score technical work from inspectable structure: authored source surface, vendored-code ratio, language mix, tests and CI, systems or research artifacts, history, releases, benchmarks, and documentation. Treat popularity as weak corroboration and lower confidence whenever tree or code evidence is incomplete.

## Enabled should mean runnable

An operator-facing source switch must validate its server-side connection or stored source configuration before persisting an enabled state. Keep the check at the authenticated mutation boundary and fail closed with operator-readable guidance; otherwise the dashboard can claim coverage while scheduled discovery silently does nothing.

## Provider identity must bridge profile enrichment

A repository event may create a candidate under a provider handle before the verified profile reveals a real name or personal site. Resolve that second observation through the existing provider subject ID, not a search for the new display name, then conservatively merge the new fields while keeping the slug stable. Otherwise enrichment can silently create a duplicate and the personal-site crawler never receives its input.

## Exercise security headers through native browser flows

A header can be individually reasonable and still break another defense. In Chromium, a `no-referrer` policy can make a native same-origin form POST carry `Origin: null`, which a strict CSRF origin check correctly rejects. Test login, logout, and mutations through the rendered forms after changing headers; use `same-origin` when external referrer suppression and a trustworthy same-origin `Origin` are both required.

## Filter effects can capture fixed descendants

`filter` and `backdrop-filter` establish containing blocks for fixed-position descendants. A mobile bottom navigation nested inside a blurred fixed header can therefore resolve `bottom: 0` against the header instead of the viewport and cover the logo. Mount viewport-fixed controls outside filtered ancestors, or disable the ancestor effect at that breakpoint, and verify geometry with `getBoundingClientRect` rather than trusting a full-page screenshot.

## Saved discovery settings must match executable budgets

An operator should never be able to save a query, URL, page definition, or result cap that the connector silently ignores. Keep dashboard validation, stored defaults, and runtime slice limits aligned, and test that every accepted configured item can execute. A visible saved setting that never runs is worse than a clear bounded limit because it creates false coverage.

## Feed bylines are plural evidence, not one string

RSS and Atom creator fields can be arrays, nested author objects, or generic publisher bylines. Flatten and deduplicate real people, emit one bounded event and stable external ID per author, and narrowly reject obvious staff/team/publisher placeholders. Collapsing an author array loses candidates; treating the publisher as a person pollutes identity resolution.

## Apply global limits after fair source interleaving

A multi-source connector that appends results sequentially and truncates once at the end lets the first prolific source starve every later source. Bound each source independently, then round-robin the groups before applying the global cap. This preserves predictable cost while making configured source coverage real instead of order-dependent.

## Runtime budgets must not expand with the workload

A configured enrichment or summarization cap stops protecting cost and function duration if the runtime takes the maximum of that cap and the number of affected records. Rank the full workload, then process only the fixed budget. Persist the remainder for later bounded runs instead of letting a large first ingestion hit the platform timeout and strand its run state.

## Zero is a value, not a processing-state marker

A candidate can be reviewed correctly and still receive a score of zero. Backlog selection must use explicit review output, such as populated score components or a reviewed timestamp, instead of treating `score = 0` as "not processed." Otherwise valid zero-score records are selected forever and starve the queue behind them.

## Backlog work must not use the finished-work ranking

A score-descending candidate query is appropriate for an operator queue but can permanently starve automatic scoring: reviewed candidates stay at the top while zero-score candidates never enter the bounded batch. Background review must drain an explicit pending cohort in stable oldest-first order, then use ranked records only to fill spare capacity. Keep expensive narrative generation under a smaller cap than deterministic scoring so the backlog can advance without exceeding runtime or model budgets.

## Contactability is an evidence claim

A contact route must be explicit on a verified candidate-owned or provider profile and retain its source URL; never synthesize or guess an address. For likely minors, suppress direct email and personal contact forms even when public, and expose only verified public profiles or institutional routes. Contact convenience must not override identity confidence or age-sensitive privacy.

## Multi-profile observations must preserve binding immutability

A discovery observation can carry several provider identities, but resolving only the first silently prevents cross-source linking. Resolve every bounded identity, then bind secondary profiles only when the association and provider subject are strong enough. Once a provider subject is attached to a candidate, a later observation must never reassign it automatically; conflicting evidence belongs in an operator-review hypothesis.

## JSON predicates and observation windows need explicit handling

PostgREST equality helpers do not reliably serialize an object literal as a JSON comparison value; use an explicit JSON filter string and exercise it against the real database. Any upserted first/last observation pair must also merge both bounds with the stored window. Updating only the last timestamp can violate ordering when a later ingestion discovers older evidence.

## A graph edge is operational only when both endpoints stay candidate-bound

Persisting account nodes and edges is not enough to support candidate discovery or neighbor queries. Bind verified provider nodes to their candidate records, preserve that binding when later edge observations upsert the node, and store the public evidence path on every graph-derived event. Otherwise the graph may render as connected while scheduled expansion, scoring, and candidate-to-candidate traversal cannot use it.

## Cross-profile links have different proof strengths

A social link on a candidate-owned page is a useful lead, but only an explicit `rel=me`, Person `sameAs`, matching verified handle, or durable provider subject should bind it automatically. Ordinary profile links should create review hypotheses, and repositories, share routes, employer sites, and same-name search results should not become identities. Preserve the exact source URL so an operator can audit every association.

## Review cutoffs must be calibrated against actual score yield

A theoretical 0–100 score does not make a preset meaningful. Measure the distribution produced by current connectors and scoring rules, then choose broad, balanced, and selective cutoffs that return useful cohort sizes on representative data. Keep compatibility for stored legacy presets so a scoring recalibration cannot silently empty the operator queue.

## Generated briefs need an explicit completion contract

Deterministic event titles must not masquerade as a synthesized operator brief. Require a minimum set of generated facts, validate every cited URL against stored evidence, and show a clear pending state until that contract is satisfied. Persist the prompt-policy version separately from an evidence hash and require the current version at display time; invalidating a fingerprint alone does not stop stale copy from rendering while a backlog drains. Reuse the same brief representation across queues, search results, and email so one surface cannot quietly fall back to lower-quality copy.

## Structured model schemas are only transport validation

Model providers support a narrower JSON Schema subset than application validators; URI-format constraints can reject an otherwise valid structured-output request before generation. Keep provider schemas to portable shapes, then perform exact URL, provenance, and business-rule validation against stored evidence before marking derived content complete.

## Enrichment and surfacing need separate completion gates

A candidate can be worth briefing before independent corroboration exists, but that does not make them ready for an operator queue or email. Drain the briefing backlog broadly, rotate enrichment toward low-coverage records, and enforce independent-publisher coverage only at the surfacing boundary. Counting multiple pages from one platform as multiple sources defeats the gate.

## Hidden source diversity is not operator-visible corroboration

A record can have events from several connectors while every displayed claim still cites one host. Enforce publisher diversity on the citations that reach the queue and email, and group search-located pages by their final citation host. A search provider pointing back to GitHub is GitHub evidence, not an independent source.

## Repository ownership and scoring evidence must survive round trips

Provider endpoints that list repositories may include forks even when the user owns the namespace. Exclude forks before attribution and complexity analysis, and audit stored claims when this invariant changes. Persist metrics and tags with each event; otherwise later background rescoring sees only prose, silently drops technical depth to zero, and rewards project quantity instead of inspectable quality.

## Model-written summaries are not evidence

Never feed an earlier model summary back as the factual record for a later model call. Persist the connector-extracted excerpt separately and ground every later generation in that raw public text. Otherwise one plausible hallucination acquires the appearance of source evidence and can survive citation checks.

## A submission is not proof of authorship

A public account submitting or sharing a link proves the account action, not that the account owner made the linked work. Promote a submission into candidate achievement evidence only when the source explicitly attributes authorship, such as a first-person Show HN description. Keep ordinary sharing as low-confidence graph context.

## Operational ordering can be undone after hydration

A database query can correctly prioritize a backlog and still fail if application code re-sorts the hydrated records by a stale field. Treat the database claim order as authoritative for bounded workers, and test the first selected records against the intended rotation policy.

## Coverage counters must share the surfacing threshold

Publisher counts used for scheduling, scoring, queue gates, and UI labels must all exclude the same low-confidence and non-substantive events. If one refresh path counts weak locator matches, it can undo a database correction and make a single-source record look corroborated again.

## Fresh enrichment is a delta, not a candidate history

An enrichment result contains only evidence found during that pass. Before recalculating score or source coverage for an affected candidate, reload the persisted event history and merge the delta into it. Scoring a locator-only delta can erase years of substantive work and silently remove a strong person from the queue.

## Enrichment should optimize marginal surfacing yield

A low-coverage-first backlog can let zero-score, zero-source records consume every bounded research slot while strong single-source candidates remain one corroborating source away from the operator queue. Rank due enrichment by demonstrated quality first, then use source coverage and oldest attempt as tie-breakers. Automatic review should establish quality; enrichment should spend its separate budget where another source is most likely to produce an operator-ready profile.

## Scheduled workers need single-purpose budgets

A source-enrichment worker can fit its network budget and still time out if it also drains a model-generation backlog before returning. Keep research, deterministic scoring, and LLM briefing on independently bounded schedules with separate durable state. Automatic does not mean synchronous: decoupled cron workers are still automatic, and they keep one slow provider from stranding unrelated work.

## Failed model work needs durable backoff

Releasing a failed generation claim immediately makes the same high-priority records eligible on every scheduled run. Deterministic failures then consume the budget forever and starve the backlog behind them. Reuse the durable claim deadline as a retry-after time, or persist an explicit retry schedule, and back off contract failures without ever publishing fallback copy.

## Deep research needs rotating passes, not one oversized request

Repeating one broad search more often mostly returns cached duplicates, while raising a synchronous batch cap makes timeout loss more likely. Claim candidates atomically, run several bounded passes with distinct identity, work, and alias/collaborator query plans, and persist progress after every pass. Increase throughput by scheduling more small claimed batches, then move completed candidates onto a slower maintenance cadence.

## Finish research against the revision you claimed

An enrichment pass can discover a new alias, profile, website, or event while it is running. If completion simply marks the candidate current, that newly created lead can be stranded until maintenance cadence. Claim a durable input revision, complete only through that revision, and immediately requeue when the stored input revision advanced during the pass. This turns every new identity lead into bounded follow-up work without creating an unbounded synchronous crawl.

## Research revisions should coalesce, not count every evidence row

An enrichment pass can insert several events for one person. If each event increments a durable research revision and the worker sorts by the raw revision gap, a productive profile can reclaim every bounded batch while untouched candidates never receive a first pass. Coalesce changes observed during one pass into a single pending follow-up, complete the observed revision atomically, and put first-pass rotation ahead of revision urgency. Verify actual progress from the run ledger; a cron expression in source control is not evidence that a production scheduler is invoking it.

## Cron frequency limits apply per schedule, not per route

When a hosting plan permits many cron jobs but each expression can run only daily, one oversized invocation is the wrong workaround: it still inherits the function timeout. If the platform explicitly supports repeated routes, distribute bounded, lease-backed invocations across distinct once-daily expressions. Assume plan-level timing jitter can make shards overlap, preserve `SKIP LOCKED` claims and idempotent completion, and give time-sensitive dispatchers a bounded catch-up window tied to the original scheduled timestamp.

## A local scheduler must cover every production job class

Running enrichment and briefing locally can make a pipeline look alive while delivery and source discovery remain completely inert. Keep the local worker manifest in parity with every production cron route, and send the production scheduler headers that affect route behavior. Verify each job class independently from its durable database output: ingestion runs for discovery and enrichment, current-policy brief counts for model work, and sent digest records plus subscriber timestamps for email.

## More cron shards do not justify repeating every pipeline phase

A frequent enrichment shard should claim a small research batch and return. If it also repeats graph expansion and a broad review refresh, the extra schedules multiply the most expensive work and can produce more timeouts instead of more completed people. Give discovery, graph expansion, enrichment, briefing, and delivery separate budgets, then measure completed durable records rather than invocation count.

## Serverless run ledgers need timeout recovery

A function timeout kills the process before application-level catch or finally logic can close a run row. On each new invocation, atomically fail running ledger entries older than the platform budget and let expired candidate claims rotate normally. Otherwise schedules can be firing while the operator sees an ever-growing set of phantom running jobs.

## Shadow durable workers before scheduler cutover

A new process worker should consume the same atomic, lease-backed claims as the serverless worker before the old scheduler is disabled. Short overlap proves credentials, network access, shutdown behavior, and real database progress without duplicate ownership. Make the worker deadline shorter than its claim lease, verify several durable completions, then disable the legacy claim path with an explicit production flag rather than relying on deployment timing.

## Identity bridges must route to a real enrichment connector

Persisting a safe cross-index identity is not enough if the enrichment scheduler assumes every identity provider is also a connector name. Map bridge identities, such as DOI plus author position, to the provider that can resolve them and test that the connector is actually invoked. Measure inserted corroborating evidence, not merely the presence of the bridge row.

## New evidence should supersede failed-generation backoff

A brief that failed its evidence contract should back off, but a later substantive source may be exactly what makes it generatable. Clear the brief retry deadline when new high-confidence evidence is inserted, while excluding profile and graph hypotheses so weak locators cannot create a generation loop.
