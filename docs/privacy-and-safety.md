# Privacy, minors, and security

Unfound processes public personal information for internal scouting. “Public” describes access, not risk. The system should collect less than it technically can, preserve provenance, and keep a human accountable for every consequential decision.

This document is an engineering policy baseline, not legal advice. The operator should review applicable privacy, employment, education, anti-discrimination, and child-safety obligations for each region and use case.

## Data classification

| Class | Examples | Handling |
| --- | --- | --- |
| Public evidence | Competition placement, paper, public repository, public project page | Store source URL and retrieval date; minimize copied text |
| Derived scouting data | Scores, summary, why-now, watch status, graph proximity | Private workspace only; label as interpretation and version it |
| Internal review data | Notes, pass/save reasons, interview/referral state | Strict access control and audit; never expose to candidates or source APIs |
| Operational secrets | Service-role key, API tokens, cron/session secrets | Secret manager only; never database rows, browser bundles, logs, or prompts |
| Prohibited inference | Race, religion, health, disability, sexuality, politics, family wealth | Do not collect, infer, rank, embed, or use as model features |

Do not infer age from a photograph or graduation year. Store a public, explicit career-stage statement only when it is relevant and source it. Avoid exact dates of birth.

## Special handling for minors

Competition and school sources can involve people under 18. Apply stricter defaults whenever age is known, stated, or reasonably uncertain:

- collect only the achievement and evidence necessary for scouting;
- do not enrich home address, personal phone, personal email, family members, daily location, or non-professional social activity;
- keep location coarse and remove unnecessary school-year details from digests;
- never use face recognition or infer identity from a photograph;
- do not automate outreach or messaging;
- require a human to verify identity, context, appropriate contact channel, and local requirements before outreach;
- prefer organizer, guardian, institutional, or user-initiated channels where appropriate;
- honor deletion/correction promptly and propagate it to summaries, embeddings, graph edges, caches, and future discovery suppression;
- review minor records more frequently and expire unsupported/stale profiles.

A public result page is evidence of the result, not permission to build a broad personal dossier.

## Collection rules

Collect an item only when all are true:

1. It is publicly available without bypassing authentication, access controls, paywalls, CAPTCHA, or technical restrictions.
2. The source’s current terms and robots rules permit the intended access.
3. It is relevant to demonstrated work, research, competition, building, or a public professional graph signal.
4. A stable source URL and retrieval timestamp can be stored.
5. Retention and correction behavior are defined.
6. Collection is proportionate, especially for minors and low-profile people.

Do not import private contact books, leaked datasets, brokered sensitive data, private messages, or non-public profiles. Do not scrape LinkedIn without explicit authorization. X graph access must use permitted official APIs and configured read-only scopes.

## Facts, identity, and model interpretation

Keep three layers separate:

- **Observation:** exactly what a source reported, with source ID and URL.
- **Resolution:** the confidence and reasons that observations belong to one person.
- **Interpretation:** score, summary, earlyness, why-now, and recommendation.

The UI and email should never present an inferred identity or LLM summary as a verified fact. Low-confidence or same-name cases stay in review and are excluded from automated outreach.

An LLM receives a bounded evidence packet. Treat source text as untrusted data that may contain prompt injection. Do not place scraped text in system/developer instructions, allow it to choose tools, or follow embedded requests. Validate structured output and require every cited source ID to exist in the packet.

## Fairness and learned taste

Past selection can encode prestige, geographic, network, and demographic bias. The taste learner must:

- use reviewer outcomes and evidence features, not protected traits;
- preserve a fixed exploration allocation outside the dominant graph and institution clusters;
- cap weekly weight changes and require minimum label volume;
- report source, school, geography, and graph concentration without inferring protected demographics;
- retain version history and support rollback;
- keep humans responsible for outreach, interviews, and selection.

“Similar to previously selected people” is not an acceptable standalone rationale.

## Access control

- The dashboard password and session secret are server-only environment variables.
- Production fails closed if either dashboard secret is missing or invalid.
- Sessions use an HTTP-only, same-site, secure-in-production cookie.
- Mutation and preview routes re-authorize the request server-side.
- Cron endpoints require a separate bearer secret.
- Supabase publishable clients rely on narrowly scoped RLS; service-role clients are server-only and bypass RLS.
- Shared-password access is suitable only for a small internal prototype. Use managed identity, named accounts, MFA, and per-user audit logs before adding a broader team or external reviewers.

Never rely on Next.js Proxy/middleware or a dashboard layout as the only authorization boundary.

## Database security

- Enable RLS on every exposed-schema table.
- A policy with only `TO authenticated` is not object authorization; include the workspace/owner predicate.
- UPDATE policies need both `USING` and `WITH CHECK`, plus an applicable SELECT policy.
- Keep privileged functions outside exposed schemas, revoke default `PUBLIC` execute, fix `search_path`, and validate authorization inside any necessary security-definer function.
- Use `security_invoker` views where supported.
- Separate source observations, canonical identities, internal notes, and operational delivery logs so each can have a narrower policy.
- Store normalized evidence and only the raw fields needed for audit/reprocessing.
- Encrypt backups, test restore, and restrict production exports.

## Application and connector threats

### SSRF and unsafe URLs

Source URLs are attacker-controlled. Reject private/loopback/link-local/reserved IPs, URL credentials, unsupported protocols, and unsafe redirects. Re-resolve and re-check redirect targets. Set response byte limits and timeouts. Prefer fixed API origins and allowlisted organizer domains.

### Stored content and links

Sanitize plain text on ingestion and rely on React escaping. Do not render scraped HTML. Email and dashboard links allow only HTTP(S). Add `rel="noopener noreferrer"` to external browser links. Never proxy arbitrary candidate-supplied images through privileged infrastructure.

The weekly email intentionally uses initials instead of source-hosted profile images, avoiding recipient-IP disclosure to arbitrary third-party image hosts.

### Denial of service and cost

Cap queries, lookback, results, graph width/depth, response size, LLM tokens, and enrichment frequency. Apply per-origin pacing and bounded retry with jitter. A dashboard setting may lower a cap, not remove it.

### Secrets and logs

Redact Authorization, cookies, emails, tokens, prompt evidence packets, and raw payloads from logs. Operational results should use IDs and counts. Provider errors must be normalized before returning to a route.

## Retention baseline

The data owner should approve exact periods. A conservative starting policy is:

| Data | Default review point | Action |
| --- | --- | --- |
| Raw source payload | 30 days | Delete unless needed for an active audit or parser migration |
| Normalized public event | 12 months after last verification | Re-verify, archive, or delete |
| Unresolved identity cluster | 90 days | Resolve or delete |
| Passed candidate with no follow-up | 12 months | Delete or reduce to suppression fingerprint |
| Active/watch candidate | Every 6 months | Re-verify evidence and necessity |
| Internal review note | 12 months after workflow closes | Delete unless documented retention need exists |
| Email delivery event | 90 days | Aggregate status; retain longer only for compliance need |
| Audit and deletion record | Policy-defined | Minimize content while retaining accountability |

Source deletion, a valid correction request, or discovery of prohibited data overrides the normal schedule.

## Correction and deletion workflow

1. Authenticate the requester proportionately without collecting unnecessary identity documents.
2. Locate candidate, aliases, source observations, embeddings, graph edges, summaries, exports, caches, and delivery references.
3. Pause surfacing and enrichment while the request is reviewed.
4. Correct facts at the observation/resolution layer, then regenerate derived data.
5. For deletion, remove personal content and retain only a minimal suppression token when needed to prevent re-ingestion.
6. Record completion, scope, reviewer, and date without copying the deleted content into the audit note.
7. Notify internal reviewers if a materially wrong identity or claim appeared in a digest.

Do not delete a public source on behalf of its publisher; remove Unfound’s copy/link and direct the requester to that publisher for the original.

## Pre-production safety review

- Test production with missing dashboard secrets and confirm access is denied.
- Test every mutation and preview endpoint without a session.
- Test every cron route with missing, malformed, and wrong bearer headers.
- Run Supabase advisors and inspect all RLS policies and grants.
- Scan built client assets for secret names and accidental values.
- Test same-name identity cases and correction propagation.
- Test connector redirects to private IPs, oversized payloads, 429s, and malformed source content.
- Confirm email recipients are isolated, source links are HTTP(S), and minors do not receive automated outreach.
- Review source terms, enabled fields, and retention dates.
- Verify learned-ranking updates cannot remove exploration or mutate factual evidence.
