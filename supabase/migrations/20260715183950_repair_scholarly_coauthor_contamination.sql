-- A provider author endpoint returns complete paper author lists. Older
-- enrichment code treated those coauthors as observations of the candidate
-- being enriched, binding their scholarly identities and papers to one person.
--
-- This repair is deliberately anchored: a candidate must have a Semantic
-- Scholar or OpenAlex identity whose normalized display name matches the
-- candidate before differently named scholarly identities are quarantined.
-- Coauthor graph nodes and edges remain; only the incorrect candidate binding
-- and incorrectly attributed evidence are removed.

create temporary table contaminated_scholarly_identities on commit drop as
with scholarly as (
  select
    candidates.workspace_id,
    candidates.id as candidate_id,
    candidates.canonical_name,
    identities.id as identity_id,
    identities.provider,
    identities.provider_subject_id,
    identities.display_name,
    regexp_replace(lower(candidates.canonical_name), '[^[:alnum:]]+', '', 'g') as candidate_name_key,
    regexp_replace(lower(identities.display_name), '[^[:alnum:]]+', '', 'g') as identity_name_key
  from public.candidates
  join public.identities
    on identities.workspace_id = candidates.workspace_id
   and identities.candidate_id = candidates.id
  where identities.provider in ('semantic-scholar', 'openalex')
), anchored_candidates as (
  select distinct workspace_id, candidate_id
  from scholarly
  where candidate_name_key = identity_name_key
)
select scholarly.*
from scholarly
join anchored_candidates using (workspace_id, candidate_id)
where scholarly.candidate_name_key <> scholarly.identity_name_key;

create index contaminated_scholarly_candidate_idx
  on contaminated_scholarly_identities (workspace_id, candidate_id);
create index contaminated_scholarly_subject_idx
  on contaminated_scholarly_identities (workspace_id, provider, provider_subject_id);

-- Remove events whose provider author identifier is one of the coauthors that
-- was incorrectly bound to this candidate. The source can rediscover these
-- papers later under the correct person.
delete from public.events as events
using contaminated_scholarly_identities as contaminated
where events.workspace_id = contaminated.workspace_id
  and events.candidate_id = contaminated.candidate_id
  and lower(events.source_label) = contaminated.provider
  and contaminated.provider_subject_id is not null
  and (
    (
      contaminated.provider = 'semantic-scholar'
      and right(events.external_id, char_length(contaminated.provider_subject_id) + 1)
        = ':' || contaminated.provider_subject_id
    )
    or (
      contaminated.provider = 'openalex'
      and right(upper(events.external_id), char_length(contaminated.provider_subject_id) + 1)
        = '/' || upper(contaminated.provider_subject_id)
    )
  );

-- Crossref may have followed a polluted DOI-authorship identity. Remove only
-- scholarly publication events whose stated author is one of the quarantined
-- coauthor names on the same candidate.
delete from public.events as events
using contaminated_scholarly_identities as contaminated
where events.workspace_id = contaminated.workspace_id
  and events.candidate_id = contaminated.candidate_id
  and lower(events.source_label) in ('semantic-scholar', 'openalex', 'crossref')
  and regexp_replace(lower(events.title), '[^[:alnum:]]+', '', 'g')
      like contaminated.identity_name_key || 'published%';

-- Keep graph structure but remove incorrect candidate bindings from account
-- nodes created for the polluted provider identities.
update public.graph_nodes as nodes
set candidate_id = null,
    updated_at = now()
from contaminated_scholarly_identities as contaminated
where nodes.workspace_id = contaminated.workspace_id
  and nodes.candidate_id = contaminated.candidate_id
  and nodes.provider = contaminated.provider
  and lower(nodes.external_key) = lower(contaminated.provider_subject_id);

delete from public.identity_candidates as hypotheses
using contaminated_scholarly_identities as contaminated
where hypotheses.workspace_id = contaminated.workspace_id
  and hypotheses.identity_id = contaminated.identity_id
  and hypotheses.candidate_id = contaminated.candidate_id;

update public.identities as identities
set candidate_id = null,
    resolution_status = 'unresolved',
    match_confidence = least(identities.match_confidence, 0.5),
    match_method = 'quarantined-coauthor-enrichment',
    distinguishing_facts = identities.distinguishing_facts || jsonb_build_object(
      'quarantinedAt', now(),
      'quarantineReason', 'coauthor emitted by author-specific scholarly enrichment'
    ),
    updated_at = now()
from contaminated_scholarly_identities as contaminated
where identities.workspace_id = contaminated.workspace_id
  and identities.id = contaminated.identity_id;

-- Invalidate generated output and scoring for every repaired candidate. The
-- existing brief/review workers will rebuild these fields from the remaining
-- evidence rather than continuing to display claims sourced from deleted rows.
update public.candidates as candidates
set summary_md = '',
    why_now_md = '',
    earlyness_md = '',
    score_components = '{}'::jsonb,
    brief_evidence_fingerprint = null,
    brief_generated_at = null,
    brief_model = null,
    brief_prompt_version = null,
    brief_claimed_until = null,
    enrichment_next_at = now(),
    research_input_revision = research_input_revision + 1,
    updated_at = now()
where exists (
  select 1
  from contaminated_scholarly_identities as contaminated
  where contaminated.workspace_id = candidates.workspace_id
    and contaminated.candidate_id = candidates.id
);
