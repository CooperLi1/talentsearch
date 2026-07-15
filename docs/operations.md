# Operations

This guide covers local development, Supabase setup, private-dashboard access, scheduled discovery, weekly email delivery, and incident response.

## Prerequisites

- Node.js 22 LTS and npm
- Docker Desktop or another Docker-compatible runtime for local Supabase
- Current Supabase CLI; check commands with `supabase --help` rather than relying on an older command shape
- A Supabase project for shared environments
- A Vercel project for scheduled production routes
- A Resend account and verified sending domain before real delivery

## Local setup state

The application is safe to explore without third-party keys:

```bash
npm install
cp .env.example .env.local
npm run dev
```

Set a local `DASHBOARD_PASSWORD`, a random `SESSION_SECRET` of at least 32 characters, and keep:

```dotenv
EMAIL_DELIVERY_MODE=preview
```

In preview mode the email layer validates and prepares a digest but does not initialize Resend or make a delivery request. Empty connector credentials leave authenticated connectors disabled or on their documented public rate budget. When Supabase is not configured, the UI shows an explicit setup state and never inserts or displays sample candidates.

For the full local data path:

```bash
supabase start
supabase db reset
npm run dev
```

`supabase db reset` is destructive to the local database and then replays committed migrations and seed data. It does not target the linked remote project.

### Operational checks

After `.env.local` is configured, use the repository checks instead of testing credentials through the UI:

```bash
npm run check:connections
npm run setup:operator
```

`check:connections` performs read-only, low-cost checks and never prints credential values. Brave is reported as configured without spending a search request. `setup:operator` idempotently adds or reactivates the address in `INITIAL_DIGEST_SUBSCRIBER_EMAIL`; run it only after migrations have created the workspace and subscriber table.

The OpenAlex check uses its read-only `/rate-limit` endpoint. Create a free key at [OpenAlex API settings](https://openalex.org/settings/api), store it as `OPENALEX_API_KEY`, and restart or redeploy before enabling the OpenAlex source in the dashboard. `OPENALEX_EMAIL` is legacy attribution and is not a substitute for the key.

With the development server running on port 3001, verify the private control path:

```bash
OPERATIONAL_TEST_URL=http://localhost:3001 npm run test:operational
```

That check covers unauthenticated rejection, login/session creation, cross-origin mutation rejection, a source mutation, and dashboard rendering. A `503` source-mutation result means the app correctly detected that the Supabase schema is not installed; it is not a ready production result.

## Environment variables

Use [`.env.example`](../.env.example) as the inventory. Store production values in Vercel project settings or an approved secret manager, not in Git.

| Group | Required in production | Notes |
| --- | --- | --- |
| App | `NEXT_PUBLIC_APP_URL` | Canonical HTTPS origin used for dashboard links |
| Dashboard | `DASHBOARD_PASSWORD`, `SESSION_SECRET` | Server-only; session secret must be at least 32 random characters |
| Cron | `CRON_SECRET` | Separate random server-only bearer secret |
| Supabase | `NEXT_PUBLIC_SUPABASE_URL`, publishable key, `SUPABASE_SERVICE_ROLE_KEY` | `SUPABASE_URL` may override the server URL; service role is server-only and bypasses RLS |
| LLM | `AI_GATEWAY_API_KEY` or Vercel OIDC for summaries/query parsing; `OPENAI_API_KEY` for embeddings | Server-only; never include keys or hidden candidate fields in prompts |
| Email | `EMAIL_DELIVERY_MODE`, `RESEND_API_KEY`, `RESEND_FROM` | Set mode to `send` only after preview and domain verification |
| Connectors | Source-specific tokens or contact emails | Use least-privilege read-only credentials |

Only `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_SUPABASE_URL`, and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` are intended for browser bundles. `NEXT_PUBLIC_SUPABASE_ANON_KEY` is accepted only as a legacy fallback and should not be used for new configuration. `SUPABASE_URL` is an optional server-only override. `UNFOUND_WORKSPACE_ID` selects the default workspace for no-argument server reads. The dashboard password, session secret, cron secret, service-role key, LLM key, Resend key, and connector credentials must never use a `NEXT_PUBLIC_` prefix.

## Supabase setup and migrations

Supabase changes frequently. Before upgrading or applying a new platform feature, scan the [Supabase changelog](https://supabase.com/changelog) for relevant breaking changes.

### Local database

```bash
supabase start
supabase db reset
supabase migration list --local
```

The repository’s committed SQL migrations are the deployable source of truth. The foundation schema is `supabase/migrations/20260710103000_talent_radar_foundation.sql`. To create a new migration, use `supabase migration new descriptive_name`; do not invent timestamped filenames manually.

### Hosted project

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
supabase migration list
```

Before `db push`, review the SQL and back up production. Afterward:

1. Confirm all expected migrations appear in the remote history.
2. Confirm the `vector` extension is enabled in the `extensions` schema.
3. Verify candidate and event embedding columns are `vector(1536)`, matching the configured `text-embedding-3-small` output.
4. Run a known-match search query and inspect its query plan once the index has representative data.
5. Run database advisors and resolve security/performance findings.
6. Confirm RLS is enabled on every table in an exposed schema.
7. Confirm views use `security_invoker` or are not exposed.

Supabase began changing new projects in 2026 so SQL-created tables may not be exposed to the Data API automatically. Data API exposure and RLS are separate controls. Grant `anon` or `authenticated` access only when the browser genuinely needs a table, and add an ownership/role policy at the same time. Server-only pipeline tables should remain inaccessible to public roles.

The service-role client must be created lazily inside server-only data access code. Never import it into a Client Component or return it from a route.

## Private dashboard access

The current gate is a deliberately small internal-workspace password flow:

- `DASHBOARD_PASSWORD` is compared server-side using constant-time comparison.
- `SESSION_SECRET` signs an HTTP-only, same-site session cookie.
- production refuses access when either secret is missing or the session secret is too short;
- neither secret is sent to the client or embedded in JavaScript;
- route handlers that mutate data re-check authorization instead of trusting that a layout rendered.

Generate separate high-entropy values for `SESSION_SECRET` and `CRON_SECRET`, rotate them through the deployment environment, and expect existing sessions to be invalidated when the session secret changes.

Login attempts and dashboard API routes use a shared Supabase fixed-window limiter, so limits remain effective across Vercel instances. Client addresses are HMACed before storage. `RATE_LIMIT_HASH_SECRET` may provide a dedicated key; otherwise `SESSION_SECRET` is used. Vercel Firewall remains useful defense in depth, and managed identity is still preferable before broadening access beyond a small trusted team.

### Weekly-digest recipients

Authorized dashboard users manage recipients at `/settings#digest`. The workflow is:

1. Add a recipient name and email.
2. Validate and normalize the address server-side.
3. Store it as active, with creator and timestamp audit fields.
4. Allow pause/reactivate rather than deleting delivery history.
5. At weekly-cron start, resolve the active recipient cohort for that delivery attempt.
6. Pass the cohort to `sendWeeklyDigest`; one recipient is used per message, so addresses are never exposed to one another.
7. Persist returned Resend IDs and per-batch delivery status.

The current schema does not freeze recipients per digest: a failed retry re-resolves active subscribers. Keep recipient configuration stable while a digest is retryable. Before supporting recipient changes or administrative catch-up safely, add a protected digest-recipient snapshot and per-recipient delivery records. Do not accept recipients from query parameters on the cron route, and do not log the recipient list.

## Resend and weekly email

### First setup

1. Add the sending domain in [Resend Domains](https://resend.com/domains).
2. Publish the provided SPF and DKIM records and wait for verification.
3. Set `RESEND_FROM` to a verified-domain address and optionally set `RESEND_REPLY_TO`.
4. Keep `EMAIL_DELIVERY_MODE=preview` and review the React Email template with representative long names, URLs, and 10–15 candidates.
5. Send to an internal test cohort and check Gmail, Apple Mail, and Outlook rendering.
6. Set `EMAIL_DELIVERY_MODE=send` only in the production environment.

The template lives at `emails/weekly-digest.tsx`. `renderWeeklyDigest` in `lib/email` creates HTML and plain-text previews without Resend. Keep any preview route behind the dashboard gate because the output contains candidate data.

### Delivery guarantees

`sendWeeklyDigest` sorts and de-duplicates recipients, rejects invalid addresses, and creates batches of at most 100 messages. A deterministic key identifies each digest batch. Resend remembers an idempotency key for 24 hours; the database delivery record is the longer-lived source of truth.

The exact candidate email payload is stored on the digest items and reloaded before delivery, so an existing digest key never covers freshly ranked candidates. Missing or invalid snapshots fail closed before the sending claim.

The durable digest key and atomic database claim guard concurrent cron runs. Failed or stale-sending attempts can be reclaimed automatically for at most 23 hours; older attempts fail closed and require provider reconciliation. These controls do not make a changing recipient payload retry-safe; that requires the protected recipient snapshot described above.

If `EMAIL_DELIVERY_MODE` is not `send`, the function returns `preview` without network activity. In explicit send mode, a missing or malformed API key, missing sender, or invalid dashboard URL fails closed instead of silently treating the run as a preview.

Register Resend webhooks for delivered, bounced, complained, and suppressed events before sending beyond a test cohort. Verify webhook signatures in the receiving route, store only necessary event fields, and deactivate bounced/complaining recipients.

## Vercel Cron deployment

Cron definitions live in `vercel.json` and must target real Route Handlers. Schedules use five-field cron syntax in UTC. Vercel Cron runs only for production deployments.

| Route | Schedule | Purpose |
| --- | --- | --- |
| `GET /api/cron/discovery` | `5 12 * * *` | Daily source discovery at 12:05 UTC |
| `GET /api/cron/enrichment` | Every 30 minutes | Claim rotating deep-research passes and follow provider, site, and public-search leads |
| `GET /api/cron/briefs` | Hourly, plus three catch-up shards | Drain up to six grounded candidate briefs per invocation |
| `GET /api/cron/weekly-digest` | Hourly at `:50` | Preparation and delivery dispatcher |

The digest route runs every 15 minutes and checks the active criterion. Operators choose one or more weekdays, a UTC send time in 15-minute increments, preparation lead time, and candidate count. The preparation phase freezes the ranked candidate payload under the future send window's durable digest key. At send time the same route reloads that frozen snapshot, re-resolves active `digest_subscribers`, claims delivery, and calls `sendWeeklyDigest` from `lib/email/send-weekly-digest`. If preparation was missed, the send phase can create the same snapshot immediately without changing the idempotency key. This schedule requires a Vercel plan that permits sub-daily cron frequency; otherwise use an external scheduler with the same route and authorization header.

Every cron route must require:

```text
Authorization: Bearer <CRON_SECRET>
```

Compare the complete header value and return `401` before doing database or connector work. Never authorize a cron route using a public query token.

Vercel cron delivery is best-effort: an invocation can be missed or delivered more than once, and failed invocations are not automatically retried. Each job therefore needs both:

- a database lock or lease to prevent overlapping runs;
- reconciliation based on stored cursors, event keys, digest cohorts, and delivery records so missed or duplicate runs are safe.

Do not rely on in-memory locks; serverless instances do not share state. Keep work below the function duration limit. For large source sets, have the cron create bounded work items and process them in resumable chunks.

The dedicated brief worker claims candidates atomically with a five-minute lease. Discovery and enrichment update deterministic scores but do not generate narratives; 27 daily cron shards drain the model-backed workload without making one function exceed its runtime budget. A candidate is eligible after identity resolution and one substantive event at 65% confidence or higher, so the worker can prepare records before cross-source enrichment completes. Queue and digest selection remain stricter: both require a completed brief and two evidence publishers in the displayed bullets. The worker records a versioned evidence fingerprint after a successful `gpt-4o-mini` brief, so unchanged candidates are not regenerated. New material evidence or a prompt-policy version changes the fingerprint and returns the candidate to the backlog. Generation, plain-language rewriting, and factual verification run at temperature zero. Unsupported facts fail closed, with one bounded repair attempt; no deterministic connector copy is substituted. Failed generations receive a six-hour retry-after time so repeated hard cases cannot consume every batch. Set `CANDIDATE_BRIEF_BATCH_LIMIT` conservatively enough to stay within the function duration.

`DISCOVERY_ENRICHMENT_LIMIT` is a per-invocation cap, not a backlog size; production defaults to three candidates. Production uses 48 once-daily enrichment shards, for up to 144 candidate passes per day, while keeping each network-heavy invocation below the five-minute ceiling. These frequent shards skip graph expansion and cap deterministic intelligence refresh at 20 records. The daily discovery route persists up to 80 fresh observations without research or model generation; those phases use their own workers so a slow provider cannot strand source discovery. Candidate rows are claimed with `FOR UPDATE SKIP LOCKED`, which lets delayed or overlapping Hobby invocations safely claim different people. Each candidate receives three rotating research passes, spaced at least four hours apart, before entering maintenance cadence. New events, identity hypotheses, aliases, affiliations, or websites advance a durable research revision and immediately return the candidate to the priority queue after the active pass finishes. Useful later runs return after seven days; empty later runs back off for 30 days. A failed worker claim expires automatically so the candidate returns to the backlog.

Vercel cron runs only on production deployments. Hobby permits 100 jobs but requires every individual expression to run at most once per day, with up to 59 minutes of timing jitter. `vercel.json` uses all 100 slots: 48 enrichment shards, 27 brief shards, 24 hourly delivery dispatchers, and one discovery run. The delivery route accepts Vercel's jitter for up to two hours while retaining the exact configured send time in the digest key; database claims keep delayed duplicate invocations idempotent. During local development, keep `next dev` running and start `npm run workers:local` in a second terminal. The local runner calls only localhost by default, runs delivery every 15 minutes, enrichment every five minutes, briefs every ten minutes, and discovery daily. It prevents overlapping invocations of the same job and never logs the cron secret. Use `npm run workers:once` for a single full pass when testing, or append `-- --job=weekly-digest`, `-- --job=enrichment`, `-- --job=briefs`, or `-- --job=discovery` to run one worker only. Local digest calls send the same schedule header as production so a late invocation receives the same bounded catch-up window.

### Local cron check

Scheduled delivery is not simulated by `next dev`; call the Route Handler directly:

```bash
curl -i \
  -H "Authorization: Bearer YOUR_LOCAL_CRON_SECRET" \
  http://localhost:3000/api/cron/discovery

curl -i \
  -H "Authorization: Bearer YOUR_LOCAL_CRON_SECRET" \
  http://localhost:3000/api/cron/briefs

curl -i \
  -H "Authorization: Bearer YOUR_LOCAL_CRON_SECRET" \
  http://localhost:3000/api/cron/weekly-digest
```

First call without the header and confirm it returns `401`. Then call with the local secret. Keep email in preview mode until the returned cohort, candidate count, subject, and idempotency keys are correct.

## Deployment checklist

1. Run `npx tsc --noEmit`, `npm run lint`, and `npm run build`.
2. Apply and verify Supabase migrations.
3. Configure production auth, cron, Supabase, LLM, connector, and email secrets.
4. Confirm the dashboard denies access with no cookie and with missing auth secrets.
5. Confirm cron routes deny missing and incorrect bearer tokens.
6. Run discovery manually with small connector limits; inspect warnings and same-name review cases.
7. Run a known semantic-search query and confirm source links.
8. Render the weekly email in preview mode, record the intended test recipients, and keep that configuration unchanged through the test.
9. Send to internal recipients, then verify provider IDs and webhook events.
10. Confirm production cron paths and UTC schedules in the Vercel dashboard.
11. Review source terms and minors/privacy controls before expanding collection.

## Runbooks

### Scheduled run is missing

1. Confirm the latest production deployment contains the expected `vercel.json` entry and route path.
2. Check Vercel Cron and runtime logs; preview deployments do not execute crons.
3. Check whether no invocation log exists, which can indicate best-effort delivery loss.
4. Trigger the route manually with authorization.
5. Reconcile from the last successful cursor; do not advance a cursor merely because a run started.

### Run overlaps or produces duplicates

1. Inspect active database leases and run IDs.
2. Confirm unique event keys and digest cohort uniqueness constraints exist.
3. Stop only the newer overlapping worker when safe.
4. Re-run reconciliation; do not delete events solely because they were seen twice.
5. If an email batch may have sent, check stored provider IDs before retrying.

### Connector is failing or rate-limited

1. Read the source-scoped warning and HTTP status without logging credentials or full payloads.
2. Confirm the source terms and API status have not changed.
3. Reduce `maxItems`, query count, graph width, or request rate.
4. Verify token scopes and quota.
5. Leave the connector disabled if access now requires prohibited scraping or authentication bypass.
6. Re-run only that connector from its last successful cursor.

### Weekly digest partially failed

1. Inspect the typed batch results and Resend dashboard.
2. Persist successful provider IDs before retrying.
3. Within 23 hours, retry only if the recipient configuration is unchanged; the route reloads the frozen candidate snapshot and reuses the same idempotency keys.
4. Do not modify recipient membership under an existing key; create an audited catch-up delivery.
5. After 24 hours, do not automatically retry a partial batch: reconcile it in Resend first. The current schema lacks per-recipient delivery rows needed to exclude already-sent recipients safely.
6. Deactivate bounced, complained, or suppressed recipients.

### Candidate identity was merged incorrectly

1. Pause digest eligibility for the affected identity cluster.
2. Preserve source events and split their identity links; do not erase evidence to repair a merge.
3. Record a negative resolution constraint with the reviewer and reason.
4. Regenerate summaries, embeddings, graph edges, and scores for both candidates.
5. Correct any sent internal note and honor external correction/deletion requests.

### Search quality drops after an embedding change

1. Stop mixing old and new vectors.
2. Confirm model name and dimensions match the database column and query function.
3. Create a versioned re-embedding run with progress and error state.
4. Compare a fixed evaluation set before promoting the new index.
5. Switch the active embedding version atomically and retain rollback metadata.

### Dashboard is locked out

1. Confirm both auth secrets exist in the production environment and `SESSION_SECRET` is at least 32 characters.
2. Redeploy after an environment change.
3. Rotate the password and session secret if exposure is suspected; all sessions will be invalidated.
4. Check firewall/rate-limit logs rather than weakening the gate.

### Secret or private data exposure

1. Disable affected cron/source/email routes and revoke the exposed credential immediately.
2. Rotate dependent credentials and the session secret.
3. Review logs, provider audit history, database access, and recent exports.
4. Remove secrets from source history using an approved incident process; deleting the latest commit is insufficient.
5. Assess notification and deletion obligations with the data owner.
6. Document root cause and add a narrowly reusable prevention lesson.

## Routine review

Weekly: connector warning rates, unresolved identities, digest precision, bounces/complaints, and source concentration.

Monthly: stale watchlist records, raw-payload retention, access list, service-role usage, graph expansion budgets, search evaluation set, and learned-weight deltas.

Quarterly: source terms, data inventory, deletion drills, backup restore, secret rotation, RLS/advisor results, and whether the shared-password gate should be replaced by managed identity.

## Primary references

- [Supabase CLI local development](https://supabase.com/docs/guides/local-development/cli/getting-started)
- [Supabase vector columns](https://supabase.com/docs/guides/ai/vector-columns)
- [Supabase API security and RLS](https://supabase.com/docs/guides/api/securing-your-api)
- [Vercel Cron Jobs](https://vercel.com/docs/cron-jobs)
- [Resend batch email](https://resend.com/docs/api-reference/emails/send-batch-emails)
- [Resend idempotency keys](https://resend.com/docs/dashboard/emails/idempotency-keys)
- [React Email](https://react.email/docs/introduction)
