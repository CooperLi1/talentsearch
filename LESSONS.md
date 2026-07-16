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
