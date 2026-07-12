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
