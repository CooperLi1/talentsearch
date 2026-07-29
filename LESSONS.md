# Lessons

## Identity and graph evidence

- A relationship is not an identity. Author-specific enrichment may persist
  events only for the provider subject being enriched; coauthors, collaborators,
  followers, and teammates must remain separate people represented through graph
  edges or normal discovery. When a provider endpoint returns a full member list,
  filter by its stable subject ID before merging observations into a candidate.

## Scheduled delivery recovery

- A scheduled email job needs a bounded catch-up window long enough to survive a
  failed deploy or provider outage, not only scheduler jitter. Keep the original
  scheduled timestamp as the dedupe key, and check for an existing digest before
  repeating candidate hydration so recovery is idempotent and inexpensive.
- A queue-reclaimed delivery that is intentionally skipped must transition to a
  terminal state. Leaving an empty or recipient-less job `ready` makes the oldest
  item monopolize every dispatcher invocation and prevents later schedules from
  being evaluated.
- Retry wrappers can hide non-retryable provider failures such as exhausted
  quota. Extract the nested status and provider code, surface a failing worker
  invocation, and never treat a system-wide billing or authentication failure as
  hundreds of independent candidate-quality failures.
- Treat model, prompt version, and evidence fingerprints as provenance rather
  than automatic queue invalidation. Historical regeneration must be an
  explicit, separately budgeted backfill so a metadata change cannot silently
  fan out across the full candidate table.

## Discovery throughput

- A large candidate count does not imply digest supply. Track the funnel through
  independent publisher coverage; corroboration, not raw names, can be the
  binding constraint.
- Per-candidate workers must load only that candidate's evidence. Rehydrating the
  full ranked catalog for every intelligence refresh multiplies database work
  and can turn modest discovery batches into statement timeouts.
- Activity volume and activity recency are independent signals. Persist and
  score both so sustained builders remain visible without weakening the value of
  genuinely new momentum.
- Large operator-supplied rosters should be ingested in bounded, idempotent
  batches and handed to the existing enrichment queue. Running every external
  lookup inside one web request makes useful large pages fail at serverless
  duration limits.
