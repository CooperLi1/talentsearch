"use client";

import {
  Check,
  ChevronDown,
  CircleOff,
  Plus,
  Save,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { useState } from "react";

import type { SignalSourceView } from "./signals-console";
import type {
  LinkedInProfileView,
  SourceConfigurationView,
  StructuredResultPageView,
} from "./source-config";

const querySources = new Set([
  "github",
  "gitlab",
  "openalex",
  "crossref",
  "arxiv",
  "semantic-scholar",
  "hugging-face",
  "x",
]);
const urlSources = new Set(["technical-blogs", "personal-sites", "project-launches"]);
const structuredSources = new Set(["olympiads", "science-fairs", "hackathon-showcases"]);
const lookbackSources = new Set(["github", "gitlab", "openalex", "crossref", "hugging-face"]);
const sourcesWithDedicatedControls = new Set([
  "brave-enrichment",
  "codeforces",
  "hacker-news",
]);

function lines(values: string[]) {
  return values.join("\n");
}

function parseLines(value: string) {
  return [...new Set(value.split("\n").map((item) => item.trim()).filter(Boolean))];
}

function optionStrings(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function optionNumber(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function sourceSummary(source: SignalSourceView, configuration: SourceConfigurationView) {
  if (querySources.has(source.key)) {
    const noun = source.key === "x" ? "searches" : "topics";
    return `${configuration.queries.length} ${noun}`;
  }
  if (urlSources.has(source.key)) return `${configuration.urls.length} sites`;
  if (structuredSources.has(source.key)) {
    return `${configuration.options.pages?.length ?? 0} result pages`;
  }
  if (source.key === "hacker-news") {
    return `${optionStrings(configuration.options.topicKeywords).length} topics`;
  }
  if (source.key === "linkedin") {
    return `${configuration.options.profiles?.length ?? 0} profiles`;
  }
  return "Scan limits";
}

function queryCopy(key: string) {
  if (key === "github" || key === "gitlab") {
    return {
      label: "Repository searches",
      help: "One search per line. Use plain technical areas or repository search terms.",
      placeholder: "robotics control systems\ndeveloper tools compilers\ndatabase internals",
    };
  }
  if (key === "x") {
    return {
      label: "Post searches",
      help: "One focused search per line. Broad searches tend to create more review work.",
      placeholder: '"built" robotics\n"open sourced" compiler\n"new paper" cryptography',
    };
  }
  if (key === "arxiv") {
    return {
      label: "Research topics or categories",
      help: "One topic or arXiv category per line.",
      placeholder: "cat:cs.RO\ncat:cs.CR\ncomputational biology",
    };
  }
  if (key === "hugging-face") {
    return {
      label: "Hub topics",
      help: "One focused area per line. Each scan rotates to the next topic across public models, datasets, and apps.",
      placeholder: "robotics\nscientific computing\nbioinformatics\ndeveloper tools",
    };
  }
  return {
    label: "Research topics",
    help: "One focused field or problem area per line.",
    placeholder: "robot learning\nprogram synthesis\nprotein design",
  };
}

function emptyPage(): StructuredResultPageView {
  return { eventName: "", itemSelector: "", nameSelector: "", url: "" };
}

function emptyProfile(): LinkedInProfileView {
  return { affiliations: [], name: "", profileUrl: "", reviewed: false };
}

function optionalEntries(value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, item]) =>
        item !== null &&
        item !== undefined &&
        (typeof item !== "string" || item.trim() !== ""),
    ),
  );
}

function configForSave(key: string, configuration: SourceConfigurationView) {
  const config: Record<string, unknown> = { maxItems: configuration.maxItems };
  if (querySources.has(key)) config.queries = configuration.queries;
  if (urlSources.has(key)) config.urls = configuration.urls;
  if (lookbackSources.has(key)) config.lookbackDays = configuration.lookbackDays;

  let options: Record<string, unknown> | undefined;
  if (key === "github" || key === "gitlab") {
    options = {
      complexityKeywords: optionStrings(configuration.options.complexityKeywords),
    };
  } else if (key === "codeforces") {
    options = { maxContests: optionNumber(configuration.options.maxContests, 2) };
  } else if (key === "hacker-news") {
    options = {
      feed: String(configuration.options.feed ?? "newstories"),
      minimumScore: optionNumber(configuration.options.minimumScore, 2),
      requireTopicMatch: configuration.options.requireTopicMatch !== false,
      topicKeywords: optionStrings(configuration.options.topicKeywords),
    };
  } else if (key === "brave-enrichment") {
    options = {
      maxQueries: optionNumber(configuration.options.maxQueries, 4),
      maxResults: optionNumber(configuration.options.maxResults, 8),
    };
  } else if (structuredSources.has(key)) {
    options = {
      pages: (configuration.options.pages ?? []).map((page) => optionalEntries(page)),
    };
  } else if (key === "linkedin") {
    options = {
      profiles: (configuration.options.profiles ?? []).map((profile) =>
        optionalEntries({
          ...profile,
          affiliations: profile.affiliations.length ? profile.affiliations : undefined,
        }),
      ),
    };
  }

  return {
    ...optionalEntries(config),
    ...(options ? { options } : {}),
  };
}

export function SourceConfigEditor({
  dataMode,
  sources,
}: {
  dataMode: "empty" | "live" | "unconfigured";
  sources: SignalSourceView[];
}) {
  const [selectedId, setSelectedId] = useState(sources[0]?.id ?? "");
  const [drafts, setDrafts] = useState<Record<string, SourceConfigurationView>>(
    () => Object.fromEntries(sources.map((source) => [source.id, source.configuration])),
  );
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [enabledById, setEnabledById] = useState<Record<string, boolean>>(
    () => Object.fromEntries(sources.map((source) => [source.id, source.enabled])),
  );
  const [message, setMessage] = useState<{
    error: boolean;
    sourceId: string;
    text: string;
  } | null>(null);

  const selected = sources.find((source) => source.id === selectedId) ?? sources[0];
  const configuration = selected ? drafts[selected.id] ?? selected.configuration : null;

  function updateConfiguration(
    sourceId: string,
    update: (current: SourceConfigurationView) => SourceConfigurationView,
  ) {
    setDrafts((current) => ({
      ...current,
      [sourceId]: update(current[sourceId]),
    }));
    setDirty((current) => ({ ...current, [sourceId]: true }));
    setMessage(null);
  }

  function updatePages(pages: StructuredResultPageView[]) {
    if (!selected) return;
    updateConfiguration(selected.id, (current) => ({
      ...current,
      options: { ...current.options, pages },
    }));
  }

  function updateProfiles(profiles: LinkedInProfileView[]) {
    if (!selected) return;
    updateConfiguration(selected.id, (current) => ({
      ...current,
      options: { ...current.options, profiles },
    }));
  }

  async function saveConfiguration() {
    if (!selected || !configuration || savingId) return;
    const sourceId = Number(selected.id);
    if (!Number.isSafeInteger(sourceId) || sourceId <= 0) {
      setMessage({ error: true, sourceId: selected.id, text: "This source could not be saved." });
      return;
    }

    setSavingId(selected.id);
    setMessage(null);
    try {
      const response = await fetch("/api/sources", {
        body: JSON.stringify({
          config: configForSave(selected.key, configuration),
          id: sourceId,
        }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Could not save this source");
      setDirty((current) => ({ ...current, [selected.id]: false }));
      setMessage({ error: false, sourceId: selected.id, text: `${selected.name} saved.` });
    } catch (caught) {
      setMessage({
        error: true,
        sourceId: selected.id,
        text: caught instanceof Error ? caught.message : "Could not save this source",
      });
    } finally {
      setSavingId(null);
    }
  }

  async function setSourceEnabled(enabled: boolean) {
    if (!selected || togglingId) return;
    const sourceId = Number(selected.id);
    if (!Number.isSafeInteger(sourceId) || sourceId <= 0) return;
    setTogglingId(selected.id);
    setMessage(null);
    try {
      const response = await fetch("/api/sources", {
        body: JSON.stringify({ enabled, id: sourceId }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Could not update this source");
      setEnabledById((current) => ({ ...current, [selected.id]: enabled }));
      setMessage({
        error: false,
        sourceId: selected.id,
        text: enabled ? `${selected.name} is included in scans.` : `${selected.name} is paused.`,
      });
    } catch (caught) {
      setMessage({
        error: true,
        sourceId: selected.id,
        text: caught instanceof Error ? caught.message : "Could not update this source",
      });
    } finally {
      setTogglingId(null);
    }
  }

  if (!sources.length) {
    return (
      <section className="source-config-overview" aria-labelledby="source-config-heading">
        <header className="source-toolbar">
          <div>
            <h2 id="source-config-heading">What each source looks for</h2>
            <p>Set topics, sites, and review volume for every source.</p>
          </div>
          <SlidersHorizontal aria-hidden="true" />
        </header>
        <div className="compact-empty-state compact-empty-state-left">
          <CircleOff aria-hidden="true" />
          <h2>{dataMode === "unconfigured" ? "Setup required" : "No sources available"}</h2>
          <p>Sources will be editable here once workspace setup is complete.</p>
        </div>
      </section>
    );
  }

  if (!selected || !configuration) return null;

  const pageUrlErrors = (configuration.options.pages ?? []).some(
    (page) => page.url && !isHttpUrl(page.url),
  );
  const urlErrors = configuration.urls.some((url) => !isHttpUrl(url));
  const profileUrlErrors = (configuration.options.profiles ?? []).some(
    (profile) =>
      (profile.profileUrl &&
        (!isHttpUrl(profile.profileUrl) || !/linkedin\.com\//i.test(profile.profileUrl))) ||
      (profile.websiteUrl && !isHttpUrl(profile.websiteUrl)) ||
      (profile.provenanceUrl && !isHttpUrl(profile.provenanceUrl)),
  );
  const hasValidationError = pageUrlErrors || urlErrors || profileUrlErrors;
  const query = queryCopy(selected.key);

  return (
    <section className="source-config-overview" aria-labelledby="source-config-heading">
      <header className="source-toolbar">
        <div>
          <h2 id="source-config-heading">What each source looks for</h2>
          <p>Set topics, sites, and review volume without changing connection details.</p>
        </div>
        <SlidersHorizontal aria-hidden="true" />
      </header>

      <div className="source-config-layout">
        <nav className="source-config-nav" aria-label="Choose a source to configure">
          {sources.map((source) => {
            const active = source.id === selected.id;
            return (
              <button
                aria-current={active ? "page" : undefined}
                className="source-config-nav-item"
                data-active={active}
                key={source.id}
                onClick={() => {
                  setSelectedId(source.id);
                  setMessage(null);
                }}
                type="button"
              >
                <span>
                  <strong>{source.name}</strong>
                  <small>{sourceSummary(source, drafts[source.id] ?? source.configuration)}</small>
                </span>
                {dirty[source.id] ? <i aria-label="Unsaved changes" /> : null}
              </button>
            );
          })}
        </nav>

        <form
          className="source-config-form"
          onSubmit={(event) => {
            event.preventDefault();
            void saveConfiguration();
          }}
        >
          <header className="source-config-form-header">
            <div>
              <span>Selected source</span>
              <h3>{selected.name}</h3>
            </div>
            <div className="source-config-header-actions">
              <span className={`source-config-status source-config-status-${selected.status}`}>
                {enabledById[selected.id]
                  ? selected.status === "needs-attention"
                    ? "Needs attention"
                    : "Included"
                  : "Paused"}
              </span>
              <button
                className="source-config-toggle"
                disabled={dataMode === "unconfigured" || togglingId !== null || dirty[selected.id]}
                onClick={() => void setSourceEnabled(!enabledById[selected.id])}
                title={dirty[selected.id] ? "Save changes before including this source" : undefined}
                type="button"
              >
                {togglingId === selected.id
                  ? "Updating"
                  : enabledById[selected.id]
                    ? "Pause"
                    : "Include in scans"}
              </button>
            </div>
          </header>

          <div className="source-config-fields">
            {querySources.has(selected.key) ? (
              <label className="source-config-field source-config-field-wide">
                <span>{query.label}</span>
                <small>{query.help}</small>
                <textarea
                  onChange={(event) =>
                    updateConfiguration(selected.id, (current) => ({
                      ...current,
                      queries: parseLines(event.target.value),
                    }))
                  }
                  placeholder={query.placeholder}
                  rows={7}
                  spellCheck="false"
                  value={lines(configuration.queries)}
                />
                <em>{configuration.queries.length} configured</em>
              </label>
            ) : null}

            {urlSources.has(selected.key) ? (
              <label className="source-config-field source-config-field-wide">
                <span>{selected.key === "personal-sites" ? "Sites to revisit" : "Feeds and sites"}</span>
                <small>Enter one full web address per line.</small>
                <textarea
                  aria-invalid={urlErrors}
                  onChange={(event) =>
                    updateConfiguration(selected.id, (current) => ({
                      ...current,
                      urls: parseLines(event.target.value),
                    }))
                  }
                  placeholder="https://example.org/feed.xml"
                  rows={7}
                  spellCheck="false"
                  value={lines(configuration.urls)}
                />
                <em>{urlErrors ? "Check the highlighted addresses" : `${configuration.urls.length} configured`}</em>
              </label>
            ) : null}

            {selected.key === "github" || selected.key === "gitlab" ? (
              <label className="source-config-field source-config-field-wide">
                <span>Technical depth signals</span>
                <small>Terms that indicate unusually difficult or substantial engineering.</small>
                <textarea
                  onChange={(event) =>
                    updateConfiguration(selected.id, (current) => ({
                      ...current,
                      options: {
                        ...current.options,
                        complexityKeywords: parseLines(event.target.value),
                      },
                    }))
                  }
                  placeholder="compiler\ndistributed systems\nformal verification\nembedded systems"
                  rows={5}
                  value={lines(optionStrings(configuration.options.complexityKeywords))}
                />
                <em>{optionStrings(configuration.options.complexityKeywords).length} configured</em>
              </label>
            ) : null}

            {selected.key === "codeforces" ? (
              <div className="source-config-limits source-config-field-wide">
                <label className="source-config-field">
                  <span>Recent contests</span>
                  <small>How many completed contests to check per scan.</small>
                  <input
                    inputMode="numeric"
                    max="5"
                    min="1"
                    onChange={(event) =>
                      updateConfiguration(selected.id, (current) => ({
                        ...current,
                        options: {
                          ...current.options,
                          maxContests: Number(event.target.value),
                        },
                      }))
                    }
                    type="number"
                    value={optionNumber(configuration.options.maxContests, 2)}
                  />
                </label>
              </div>
            ) : null}

            {selected.key === "hacker-news" ? (
              <div className="source-config-hn source-config-field-wide">
                <label className="source-config-field source-config-field-wide">
                  <span>Builder topics</span>
                  <small>One phrase per line. These terms focus the story stream on relevant work.</small>
                  <textarea
                    onChange={(event) =>
                      updateConfiguration(selected.id, (current) => ({
                        ...current,
                        options: {
                          ...current.options,
                          topicKeywords: parseLines(event.target.value),
                        },
                      }))
                    }
                    placeholder="robotics\ncompilers\nscientific computing\nopen source hardware"
                    rows={5}
                    value={lines(optionStrings(configuration.options.topicKeywords))}
                  />
                </label>
                <label className="source-config-check">
                  <input
                    checked={configuration.options.requireTopicMatch !== false}
                    onChange={(event) =>
                      updateConfiguration(selected.id, (current) => ({
                        ...current,
                        options: {
                          ...current.options,
                          requireTopicMatch: event.target.checked,
                        },
                      }))
                    }
                    type="checkbox"
                  />
                  <span>Only include stories matching these topics</span>
                </label>
                <div className="source-config-limits">
                  <label className="source-config-field">
                    <span>Story stream</span>
                    <small>Choose which public stories to review.</small>
                    <select
                      onChange={(event) =>
                        updateConfiguration(selected.id, (current) => ({
                          ...current,
                          options: { ...current.options, feed: event.target.value },
                        }))
                      }
                      value={String(configuration.options.feed ?? "newstories")}
                    >
                      <option value="newstories">Newest stories</option>
                      <option value="showstories">Show HN launches</option>
                      <option value="beststories">Best recent stories</option>
                      <option value="topstories">Top stories</option>
                    </select>
                  </label>
                  <label className="source-config-field">
                    <span>Minimum points</span>
                    <small>Skip posts below this community response.</small>
                    <input
                      inputMode="numeric"
                      max="10000"
                      min="0"
                      onChange={(event) =>
                        updateConfiguration(selected.id, (current) => ({
                          ...current,
                          options: {
                            ...current.options,
                            minimumScore: Number(event.target.value),
                          },
                        }))
                      }
                      type="number"
                      value={optionNumber(configuration.options.minimumScore, 2)}
                    />
                  </label>
                </div>
              </div>
            ) : null}

            {selected.key === "brave-enrichment" ? (
              <div className="source-config-limits source-config-field-wide">
                <label className="source-config-field">
                  <span>Searches per candidate</span>
                  <small>Caps follow-up searches after a person is discovered.</small>
                  <input
                    inputMode="numeric"
                    max="5"
                    min="1"
                    onChange={(event) =>
                      updateConfiguration(selected.id, (current) => ({
                        ...current,
                        options: {
                          ...current.options,
                          maxQueries: Number(event.target.value),
                        },
                      }))
                    }
                    type="number"
                    value={optionNumber(configuration.options.maxQueries, 4)}
                  />
                </label>
                <label className="source-config-field">
                  <span>Pages per candidate</span>
                  <small>Caps public pages checked for supporting evidence.</small>
                  <input
                    inputMode="numeric"
                    max="12"
                    min="1"
                    onChange={(event) =>
                      updateConfiguration(selected.id, (current) => ({
                        ...current,
                        options: {
                          ...current.options,
                          maxResults: Number(event.target.value),
                        },
                      }))
                    }
                    type="number"
                    value={optionNumber(configuration.options.maxResults, 8)}
                  />
                </label>
              </div>
            ) : null}

            {structuredSources.has(selected.key) ? (
              <div className="source-config-collection source-config-field-wide">
                <div className="source-config-collection-heading">
                  <div>
                    <span>Official results pages</span>
                    <small>Add a page and the markers used to find each result and person.</small>
                  </div>
                  <button
                    className="editorial-button editorial-button-light source-config-add"
                    onClick={() => updatePages([...(configuration.options.pages ?? []), emptyPage()])}
                    type="button"
                  >
                    <Plus aria-hidden="true" /> Add page
                  </button>
                </div>
                {(configuration.options.pages ?? []).length ? (
                  <div className="source-config-items">
                    {(configuration.options.pages ?? []).map((page, index) => (
                      <fieldset className="source-config-item" key={`${index}-${page.url}`}>
                        <legend>Page {index + 1}</legend>
                        <button
                          aria-label={`Remove results page ${index + 1}`}
                          className="source-config-remove"
                          onClick={() =>
                            updatePages((configuration.options.pages ?? []).filter((_, itemIndex) => itemIndex !== index))
                          }
                          type="button"
                        >
                          <Trash2 aria-hidden="true" />
                        </button>
                        <label className="source-config-field source-config-field-wide">
                          <span>Results page</span>
                          <input
                            aria-invalid={Boolean(page.url && !isHttpUrl(page.url))}
                            onChange={(event) => {
                              const pages = [...(configuration.options.pages ?? [])];
                              pages[index] = { ...page, url: event.target.value };
                              updatePages(pages);
                            }}
                            placeholder="https://competition.org/results"
                            type="url"
                            value={page.url}
                          />
                        </label>
                        <label className="source-config-field">
                          <span>Event name</span>
                          <input
                            onChange={(event) => {
                              const pages = [...(configuration.options.pages ?? [])];
                              pages[index] = { ...page, eventName: event.target.value };
                              updatePages(pages);
                            }}
                            placeholder="2026 International Final"
                            value={page.eventName ?? ""}
                          />
                        </label>
                        <label className="source-config-field">
                          <span>Repeated result marker</span>
                          <input
                            onChange={(event) => {
                              const pages = [...(configuration.options.pages ?? [])];
                              pages[index] = { ...page, itemSelector: event.target.value };
                              updatePages(pages);
                            }}
                            placeholder=".result-row"
                            required
                            spellCheck="false"
                            value={page.itemSelector}
                          />
                        </label>
                        <label className="source-config-field">
                          <span>Person name marker</span>
                          <input
                            onChange={(event) => {
                              const pages = [...(configuration.options.pages ?? [])];
                              pages[index] = { ...page, nameSelector: event.target.value };
                              updatePages(pages);
                            }}
                            placeholder=".participant-name"
                            required
                            spellCheck="false"
                            value={page.nameSelector}
                          />
                        </label>
                        <details className="source-config-details source-config-field-wide">
                          <summary><ChevronDown aria-hidden="true" /> Optional page markers</summary>
                          <div className="source-config-detail-grid">
                            {([
                              ["rankSelector", "Placement", ".rank"],
                              ["affiliationSelector", "School or team", ".affiliation"],
                              ["linkSelector", "Profile or project link", "a.project"],
                              ["dateSelector", "Date", "time"],
                              ["occurredAt", "Result date", "2025-07-20"],
                              ["titleSelector", "Result title", ".award"],
                              ["descriptionSelector", "Description", ".description"],
                            ] as const).map(([field, label, placeholder]) => (
                              <label className="source-config-field" key={field}>
                                <span>{label}</span>
                                <input
                                  onChange={(event) => {
                                    const pages = [...(configuration.options.pages ?? [])];
                                    pages[index] = { ...page, [field]: event.target.value };
                                    updatePages(pages);
                                  }}
                                  placeholder={placeholder}
                                  spellCheck="false"
                                  value={page[field] ?? ""}
                                />
                              </label>
                            ))}
                          </div>
                        </details>
                      </fieldset>
                    ))}
                  </div>
                ) : (
                  <p className="source-config-collection-empty">No results pages added yet.</p>
                )}
              </div>
            ) : null}

            {selected.key === "linkedin" ? (
              <div className="source-config-collection source-config-field-wide">
                <div className="source-config-linkedin-note">
                  <strong>How LinkedIn profiles enter the workspace</strong>
                  <p>
                    Public web enrichment can suggest a profile link after finding the person elsewhere. To add one directly, paste the public profile URL below, record where you found it, confirm the match, save, then choose Include in scans.
                  </p>
                  <a
                    href="https://learn.microsoft.com/en-us/linkedin/shared/authentication/getting-access"
                    rel="noreferrer"
                    target="_blank"
                  >
                    LinkedIn access options
                  </a>
                </div>
                <div className="source-config-collection-heading">
                  <div>
                    <span>Reviewed profiles</span>
                    <small>Confirm a public profile URL before importing it.</small>
                  </div>
                  <button
                    className="editorial-button editorial-button-light source-config-add"
                    onClick={() => updateProfiles([...(configuration.options.profiles ?? []), emptyProfile()])}
                    type="button"
                  >
                    <Plus aria-hidden="true" /> Add profile
                  </button>
                </div>
                {(configuration.options.profiles ?? []).length ? (
                  <div className="source-config-items">
                    {(configuration.options.profiles ?? []).map((profile, index) => (
                      <fieldset className="source-config-item" key={`${index}-${profile.profileUrl}`}>
                        <legend>Profile {index + 1}</legend>
                        <button
                          aria-label={`Remove LinkedIn profile ${index + 1}`}
                          className="source-config-remove"
                          onClick={() =>
                            updateProfiles((configuration.options.profiles ?? []).filter((_, itemIndex) => itemIndex !== index))
                          }
                          type="button"
                        >
                          <Trash2 aria-hidden="true" />
                        </button>
                        {([
                          ["name", "Person", "Full name", "text"],
                          ["profileUrl", "LinkedIn profile", "https://www.linkedin.com/in/...", "url"],
                          ["headline", "Current focus", "Optional headline", "text"],
                          ["websiteUrl", "Personal site", "https://...", "url"],
                          ["provenanceUrl", "Found on", "Candidate site or public bio URL", "url"],
                        ] as const).map(([field, label, placeholder, type]) => (
                          <label className="source-config-field" key={field}>
                            <span>{label}</span>
                            <input
                              aria-invalid={
                                field === "profileUrl"
                                  ? Boolean(
                                      profile.profileUrl &&
                                        (!isHttpUrl(profile.profileUrl) ||
                                          !/linkedin\.com\//i.test(profile.profileUrl)),
                                    )
                                  : field === "websiteUrl" || field === "provenanceUrl"
                                    ? Boolean(profile[field] && !isHttpUrl(profile[field] ?? ""))
                                    : undefined
                              }
                              onChange={(event) => {
                                const profiles = [...(configuration.options.profiles ?? [])];
                                profiles[index] = { ...profile, [field]: event.target.value };
                                updateProfiles(profiles);
                              }}
                              placeholder={placeholder}
                              required={field === "name" || field === "profileUrl"}
                              type={type}
                              value={profile[field] ?? ""}
                            />
                          </label>
                        ))}
                        <label className="source-config-check source-config-field-wide">
                          <input
                            checked={profile.reviewed}
                            onChange={(event) => {
                              const profiles = [...(configuration.options.profiles ?? [])];
                              profiles[index] = { ...profile, reviewed: event.target.checked };
                              updateProfiles(profiles);
                            }}
                            required
                            type="checkbox"
                          />
                          <span>I checked that this URL belongs to this person</span>
                        </label>
                        <label className="source-config-field source-config-field-wide">
                          <span>Review note</span>
                          <input
                            onChange={(event) => {
                              const profiles = [...(configuration.options.profiles ?? [])];
                              profiles[index] = { ...profile, note: event.target.value };
                              updateProfiles(profiles);
                            }}
                            placeholder="Why this person should enter review"
                            value={profile.note ?? ""}
                          />
                        </label>
                        <details className="source-config-details source-config-field-wide">
                          <summary><ChevronDown aria-hidden="true" /> Additional profile context</summary>
                          <div className="source-config-detail-grid">
                            <label className="source-config-field">
                              <span>Location</span>
                              <input
                                onChange={(event) => {
                                  const profiles = [...(configuration.options.profiles ?? [])];
                                  profiles[index] = { ...profile, location: event.target.value };
                                  updateProfiles(profiles);
                                }}
                                placeholder="City, region, or remote"
                                value={profile.location ?? ""}
                              />
                            </label>
                            <label className="source-config-field">
                              <span>Observed date</span>
                              <input
                                onChange={(event) => {
                                  const profiles = [...(configuration.options.profiles ?? [])];
                                  profiles[index] = { ...profile, observedAt: event.target.value };
                                  updateProfiles(profiles);
                                }}
                                placeholder="YYYY-MM-DD"
                                value={profile.observedAt ?? ""}
                              />
                            </label>
                            <label className="source-config-field source-config-field-wide">
                              <span>Schools, teams, or organizations</span>
                              <textarea
                                onChange={(event) => {
                                  const profiles = [...(configuration.options.profiles ?? [])];
                                  profiles[index] = {
                                    ...profile,
                                    affiliations: parseLines(event.target.value),
                                  };
                                  updateProfiles(profiles);
                                }}
                                placeholder="One per line"
                                rows={3}
                                value={lines(profile.affiliations)}
                              />
                            </label>
                            <label className="source-config-field source-config-field-wide">
                              <span>Profile summary</span>
                              <textarea
                                onChange={(event) => {
                                  const profiles = [...(configuration.options.profiles ?? [])];
                                  profiles[index] = { ...profile, biography: event.target.value };
                                  updateProfiles(profiles);
                                }}
                                placeholder="Optional context copied during review"
                                rows={4}
                                value={profile.biography ?? ""}
                              />
                            </label>
                          </div>
                        </details>
                      </fieldset>
                    ))}
                  </div>
                ) : (
                  <p className="source-config-collection-empty">No reviewed profiles added yet.</p>
                )}
              </div>
            ) : null}

            {!querySources.has(selected.key) &&
            !urlSources.has(selected.key) &&
            !structuredSources.has(selected.key) &&
            !sourcesWithDedicatedControls.has(selected.key) &&
            selected.key !== "linkedin" ? (
              <div className="source-config-auto-note source-config-field-wide">
                <strong>No topic list needed</strong>
                <p>This source uses its public activity and the current target profile automatically.</p>
              </div>
            ) : null}

            <div className="source-config-limits source-config-field-wide">
              {lookbackSources.has(selected.key) ? (
                <label className="source-config-field">
                  <span>Look back</span>
                  <small>Days of recent activity checked each run.</small>
                  <input
                    inputMode="numeric"
                    max="365"
                    min="1"
                    onChange={(event) =>
                      updateConfiguration(selected.id, (current) => ({
                        ...current,
                        lookbackDays: event.target.value ? Number(event.target.value) : null,
                      }))
                    }
                    placeholder="14"
                    type="number"
                    value={configuration.lookbackDays ?? ""}
                  />
                </label>
              ) : null}
              <label className="source-config-field">
                <span>Maximum per scan</span>
                <small>Caps the amount brought into review at once.</small>
                <input
                  inputMode="numeric"
                  max="500"
                  min="1"
                  onChange={(event) =>
                    updateConfiguration(selected.id, (current) => ({
                      ...current,
                      maxItems: event.target.value ? Number(event.target.value) : null,
                    }))
                  }
                  placeholder="50"
                  type="number"
                  value={configuration.maxItems ?? ""}
                />
              </label>
            </div>
          </div>

          <footer className="source-config-actions">
            <p
              aria-live="polite"
              className={message?.sourceId === selected.id && message.error ? "form-message-error" : undefined}
            >
              {message?.sourceId === selected.id
                ? message.text
                : hasValidationError
                  ? "Fix the highlighted addresses before saving."
                  : dirty[selected.id]
                    ? "Unsaved changes"
                    : "Changes apply to the next scan."}
            </p>
            <button
              className="editorial-button editorial-button-dark"
              disabled={
                dataMode === "unconfigured" ||
                !dirty[selected.id] ||
                savingId !== null ||
                hasValidationError
              }
              type="submit"
            >
              {savingId === selected.id ? (
                <>Saving</>
              ) : message?.sourceId === selected.id && !message.error ? (
                <><Check aria-hidden="true" /> Saved</>
              ) : (
                <><Save aria-hidden="true" /> Save source</>
              )}
            </button>
          </footer>
        </form>
      </div>
    </section>
  );
}
