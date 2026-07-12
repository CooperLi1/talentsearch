"use client";

import { CandidateActions } from "@/components/candidates/candidate-actions";
import { ArrowUpRight, Search, SlidersHorizontal } from "lucide-react";
import Link from "next/link";
import { FormEvent, useMemo, useState } from "react";

export type PeopleCandidateView = {
  confidence: number;
  domains: string[];
  evidence: string | null;
  id: string;
  identityWarning: string | null;
  initials: string;
  location: string;
  name: string;
  recency: string;
  score: number;
  slug: string;
  stage: string;
  status: string;
  thesis: string;
  whyNow: string;
};

export function PeopleSearch({
  candidates,
  dataMode,
}: {
  candidates: PeopleCandidateView[];
  dataMode: "empty" | "live" | "unconfigured";
}) {
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [selectedDomains, setSelectedDomains] = useState<string[]>([]);
  const [selectedStages, setSelectedStages] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);
  const [remoteOrder, setRemoteOrder] = useState<string[] | null>(null);

  const domainOptions = useMemo(
    () =>
      Array.from(new Set(candidates.flatMap((candidate) => candidate.domains)))
        .sort()
        .slice(0, 10),
    [candidates],
  );
  const stageOptions = useMemo(
    () => Array.from(new Set(candidates.map((candidate) => candidate.stage))).sort(),
    [candidates],
  );

  const results = useMemo(() => {
    const normalized = submittedQuery.trim().toLowerCase();
    const filtered = candidates.filter((candidate) => {
      const haystack = [
        candidate.name,
        candidate.thesis,
        candidate.whyNow,
        candidate.evidence ?? "",
        candidate.location,
        candidate.stage,
        ...candidate.domains,
      ]
        .join(" ")
        .toLowerCase();
      const queryMatch =
        !normalized ||
        normalized.split(/\s+/).every((term) => haystack.includes(term));
      const domainMatch =
        selectedDomains.length === 0 ||
        selectedDomains.some((domain) => candidate.domains.includes(domain));
      const stageMatch =
        selectedStages.length === 0 || selectedStages.includes(candidate.stage);
      return queryMatch && domainMatch && stageMatch;
    });

    if (!remoteOrder) return filtered.sort((a, b) => b.score - a.score);
    const rank = new Map(remoteOrder.map((slug, index) => [slug, index]));
    return filtered.sort(
      (a, b) => (rank.get(a.slug) ?? 999) - (rank.get(b.slug) ?? 999),
    );
  }, [candidates, remoteOrder, selectedDomains, selectedStages, submittedQuery]);

  function toggleValue(
    value: string,
    setter: React.Dispatch<React.SetStateAction<string[]>>,
  ) {
    setter((current) =>
      current.includes(value)
        ? current.filter((item) => item !== value)
        : [...current, value],
    );
  }

  async function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmittedQuery(query);
    setSearching(true);
    setRemoteOrder(null);

    try {
      const response = await fetch("/api/search", {
        body: JSON.stringify({
          filters: { careerStages: selectedStages, skills: selectedDomains },
          limit: 50,
          query,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      if (!response.ok) return;
      const payload = (await response.json()) as {
        results?: Array<{ candidate?: { slug?: string }; slug?: string }>;
      };
      const slugs = payload.results
        ?.map((result) => result.slug ?? result.candidate?.slug)
        .filter((slug): slug is string => Boolean(slug));
      if (slugs) setRemoteOrder(slugs);
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
          {(selectedDomains.length > 0 || selectedStages.length > 0) && (
            <button
              onClick={() => {
                setSelectedDomains([]);
                setSelectedStages([]);
              }}
              type="button"
            >
              Clear
            </button>
          )}
        </div>

        {domainOptions.length ? (
          <div className="filter-group">
            <h2 className="filter-title">Focus area</h2>
            <div className="filter-options">
              {domainOptions.map((domain) => (
                <label className="filter-option" key={domain}>
                  <input
                    checked={selectedDomains.includes(domain)}
                    onChange={() => toggleValue(domain, setSelectedDomains)}
                    type="checkbox"
                  />
                  {domain}
                </label>
              ))}
            </div>
          </div>
        ) : null}

        {stageOptions.length ? (
          <div className="filter-group">
            <h2 className="filter-title">Stage</h2>
            <div className="filter-options">
              {stageOptions.map((stage) => (
                <label className="filter-option" key={stage}>
                  <input
                    checked={selectedStages.includes(stage)}
                    onChange={() => toggleValue(stage, setSelectedStages)}
                    type="checkbox"
                  />
                  {stage}
                </label>
              ))}
            </div>
          </div>
        ) : null}
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
                  <strong>{candidate.thesis}</strong>
                </div>
                <div className="person-result-evidence">
                  <span>Why now · {candidate.recency}</span>
                  <p>{candidate.whyNow}</p>
                  {candidate.evidence ? <small>{candidate.evidence}</small> : null}
                  {candidate.identityWarning ? (
                    <small className="identity-warning">{candidate.identityWarning}</small>
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
