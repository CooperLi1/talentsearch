"use client";

import { CandidateActions } from "@/components/candidates/candidate-actions";
import type { PeopleCandidateView } from "@/lib/candidates/people-view";
import {
  buildSearchFacetOptions,
  candidateMatchesFacet,
  type SearchFacetOption,
} from "@/lib/search/facets";
import { ArrowUpRight, Search, SlidersHorizontal } from "lucide-react";
import Link from "next/link";
import { FormEvent, useMemo, useState } from "react";

type SelectedFacets = {
  domains: string[];
  eventTypes: string[];
  locations: string[];
  sources: string[];
  stages: string[];
  statuses: string[];
};

const EMPTY_FACETS: SelectedFacets = {
  domains: [],
  eventTypes: [],
  locations: [],
  sources: [],
  stages: [],
  statuses: [],
};

function FilterGroup({
  options,
  selected,
  title,
  onToggle,
}: {
  options: SearchFacetOption[];
  selected: string[];
  title: string;
  onToggle: (value: string) => void;
}) {
  if (!options.length) return null;
  return (
    <div className="filter-group">
      <h2 className="filter-title">{title}</h2>
      <div className="filter-options">
        {options.map((option) => (
          <label className="filter-option" key={option.value}>
            <input
              checked={selected.includes(option.value)}
              onChange={() => onToggle(option.value)}
              type="checkbox"
            />
            <span>{option.label}</span>
            <small>{option.count}</small>
          </label>
        ))}
      </div>
    </div>
  );
}

export function PeopleSearch({
  candidates,
  dataMode,
}: {
  candidates: PeopleCandidateView[];
  dataMode: "empty" | "live" | "unconfigured";
}) {
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [selected, setSelected] = useState<SelectedFacets>(EMPTY_FACETS);
  const [searching, setSearching] = useState(false);
  const [remoteResults, setRemoteResults] = useState<PeopleCandidateView[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);

  const facets = useMemo(() => buildSearchFacetOptions(candidates), [candidates]);
  const selectedCount = Object.values(selected).reduce(
    (total, values) => total + values.length,
    0,
  );

  const results = useMemo(() => {
    const normalized = submittedQuery.trim().toLowerCase();
    const filtered = (remoteResults ?? candidates).filter((candidate) => {
      const haystack = [
        candidate.name,
        candidate.thesis,
        ...candidate.facts.map((fact) => fact.text),
        candidate.location,
        candidate.stage,
        ...candidate.domains,
      ]
        .join(" ")
        .toLowerCase();
      const queryMatch =
        !normalized || remoteResults !== null ||
        normalized.split(/\s+/).every((term) => haystack.includes(term));
      const domainMatch =
        candidateMatchesFacet(candidate.domains, selected.domains);
      const eventTypeMatch = candidateMatchesFacet(candidate.eventTypes, selected.eventTypes);
      const locationMatch = candidateMatchesFacet([candidate.location], selected.locations);
      const sourceMatch = candidateMatchesFacet(candidate.sourceLabels, selected.sources);
      const stageMatch = candidateMatchesFacet([candidate.stage], selected.stages);
      const statusMatch = candidateMatchesFacet([candidate.status], selected.statuses);
      return queryMatch && domainMatch && eventTypeMatch && locationMatch && sourceMatch && stageMatch && statusMatch;
    });

    return remoteResults === null
      ? filtered.sort((a, b) => b.score - a.score)
      : filtered;
  }, [candidates, remoteResults, selected, submittedQuery]);

  function toggleValue(key: keyof SelectedFacets, value: string) {
    setSelected((current) => ({
      ...current,
      [key]: current[key].includes(value)
        ? current[key].filter((item) => item !== value)
        : [...current[key], value],
    }));
  }

  async function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmittedQuery(query);
    setSearching(true);
    setRemoteResults(null);
    setSearchError(null);

    try {
      const response = await fetch("/api/search", {
        body: JSON.stringify({
          filters: {
            careerStages: selected.stages,
            eventTypes: selected.eventTypes,
            locations: selected.locations,
            skills: selected.domains,
            sources: selected.sources,
            statuses: selected.statuses,
          },
          limit: 50,
          query,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      if (!response.ok) {
        setSearchError("Search could not run. The visible filters still work on loaded records.");
        return;
      }
      const payload = (await response.json()) as {
        results?: Array<{ view?: PeopleCandidateView }>;
      };
      const views = payload.results
        ?.map((result) => result.view)
        .filter((view): view is PeopleCandidateView => Boolean(view));
      setRemoteResults(views ?? []);
    } catch {
      setSearchError("Search could not run. The visible filters still work on loaded records.");
    } finally {
      setSearching(false);
    }
  }

  return (
    <div className="people-workbench">
      <aside className="people-filters">
        <div className="filter-heading">
          <SlidersHorizontal aria-hidden="true" />
          <span>Filters</span>
          {selectedCount > 0 && (
            <button
              onClick={() => {
                setSelected(EMPTY_FACETS);
              }}
              type="button"
            >
              Clear
            </button>
          )}
        </div>

        <FilterGroup options={facets.eventTypes} selected={selected.eventTypes} title="Signal" onToggle={(value) => toggleValue("eventTypes", value)} />
        <FilterGroup options={facets.sources} selected={selected.sources} title="Source" onToggle={(value) => toggleValue("sources", value)} />
        <FilterGroup options={facets.domains} selected={selected.domains} title="Focus area" onToggle={(value) => toggleValue("domains", value)} />
        <FilterGroup options={facets.stages} selected={selected.stages} title="Stage" onToggle={(value) => toggleValue("stages", value)} />
        <FilterGroup options={facets.locations} selected={selected.locations} title="Location" onToggle={(value) => toggleValue("locations", value)} />
        <FilterGroup options={facets.statuses} selected={selected.statuses} title="Review status" onToggle={(value) => toggleValue("statuses", value)} />
      </aside>

      <section className="people-main" aria-label="People search results">
        <form className="people-search-bar" onSubmit={submitSearch}>
          <Search aria-hidden="true" />
          <input
            aria-label="Describe the person you are looking for"
            disabled={dataMode === "unconfigured"}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Describe the work or experience you need"
            type="search"
            value={query}
          />
          <button
            disabled={dataMode === "unconfigured" || searching || query.trim().length < 2}
            type="submit"
          >
            {searching ? "Searching" : "Search"}
          </button>
        </form>
        {searchError ? <p className="people-search-error" role="status">{searchError}</p> : null}

        <div className="people-status">
          <span>{results.length} {results.length === 1 ? "person" : "people"}</span>
          <span>{submittedQuery ? "Best evidence match first" : "Highest score first"}</span>
        </div>

        {results.length ? (
          <div className="people-results">
            {results.map((candidate) => (
              <article className="person-result" key={candidate.id}>
                <div className="identity-mark identity-mark-small" aria-hidden="true">
                  {candidate.initials}
                </div>
                <div className="person-result-primary">
                  <div className="queue-name-line">
                    <Link href={`/people/${candidate.slug}`}>{candidate.name}</Link>
                    <span className={`status-token status-${candidate.status}`}>
                      {candidate.status}
                    </span>
                  </div>
                  <p>
                    {[candidate.stage, candidate.location].filter(Boolean).join(" · ") ||
                      "Stage and location not verified"}
                  </p>
                </div>
                <div className="person-result-evidence">
                  {candidate.facts.length ? (
                    <ul className="queue-facts person-result-facts">
                      {candidate.facts.map((fact, factIndex) => (
                        <li key={`${candidate.id}-fact-${factIndex}`}>
                          <span>{fact.text}</span>
                          <span className="queue-fact-sources" aria-label="Sources">
                            {fact.sources.map((source) => (
                              <a href={source.url} key={source.url} rel="noreferrer" target="_blank">
                                {source.label}<ArrowUpRight aria-hidden="true" />
                              </a>
                            ))}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="person-brief-pending">
                      Source-linked brief pending. Run discovery to prepare it.
                    </p>
                  )}
                  {candidate.identityWarning ? (
                    <small className="identity-warning">{candidate.identityWarning}</small>
                  ) : null}
                  {candidate.contactRoute ? (
                    <a
                      aria-label={`${candidate.contactRoute.label} for ${candidate.name}`}
                      href={candidate.contactRoute.url}
                      rel="noreferrer"
                      target={candidate.contactRoute.url.startsWith("mailto:") ? undefined : "_blank"}
                    >
                      <small>Contact · {candidate.contactRoute.label}</small>
                    </a>
                  ) : null}
                </div>
                <div className="person-result-score">
                  <strong>{candidate.score.toFixed(1)}</strong>
                  <small>Review score</small>
                  <span>Identity confidence {Math.round(candidate.confidence * 100)}%</span>
                </div>
                <div className="person-result-actions">
                  <CandidateActions
                    candidateId={candidate.id}
                    referralDisabled={Boolean(candidate.identityWarning) || /high.?school|minor/i.test(candidate.stage)}
                    status={candidate.status}
                  />
                  <Link aria-label={`Open ${candidate.name}`} href={`/people/${candidate.slug}`}>
                    <ArrowUpRight aria-hidden="true" />
                  </Link>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="compact-empty-state">
            <Search aria-hidden="true" />
            <h2>
              {candidates.length
                ? "No matching people"
                : dataMode === "unconfigured"
                  ? "Setup required"
                  : "No candidate records yet"}
            </h2>
            <p>
              {candidates.length
                ? "Try a broader description or clear one of the filters."
                : dataMode === "unconfigured"
                  ? "Finish workspace setup before searching or running discovery."
                  : "Open Sources to run discovery and look for new evidence."}
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
