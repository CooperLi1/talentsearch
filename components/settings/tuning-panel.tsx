"use client";

import { SubscriberManager, type SubscriberView } from "@/components/settings/subscriber-manager";
import type { CriterionProfile, DiscoverySource } from "@/lib/domain/types";
import { Check, RotateCcw, Save } from "lucide-react";
import { useState } from "react";

const fallbackSignals: CriterionProfile["signals"] = [
  {
    description: "Evidence that someone built something original",
    enabled: true,
    key: "projectOriginality",
    label: "Original work",
    weight: 0.2,
  },
  {
    description: "Difficulty and depth of the demonstrated work",
    enabled: true,
    key: "technicalComplexity",
    label: "Technical depth",
    weight: 0.18,
  },
  {
    description: "Recent evidence of increasing ambition or output",
    enabled: true,
    key: "trajectoryVelocity",
    label: "Recent momentum",
    weight: 0.17,
  },
  {
    description: "Independent use, collaboration, or trusted attention",
    enabled: true,
    key: "networkProximity",
    label: "External pull",
    weight: 0.14,
  },
  {
    description: "Difficulty and selectivity of a verified achievement",
    enabled: true,
    key: "achievementQuality",
    label: "Achievement quality",
    weight: 0.11,
  },
  {
    description: "Agreement across independent public sources",
    enabled: true,
    key: "evidenceDiversity",
    label: "Independent evidence",
    weight: 0.1,
  },
  {
    description: "Strong work relative to current recognition",
    enabled: true,
    key: "earlyness",
    label: "Still early",
    weight: 0.1,
  },
];

const qualityOptions = [
  { label: "Broad · more people to inspect", value: 62 },
  { label: "Balanced · strong evidence", value: 75 },
  { label: "Selective · exceptional evidence", value: 86 },
];

export function TuningPanel({
  criterion,
  sources,
  subscribers,
}: {
  criterion: CriterionProfile;
  sources: DiscoverySource[];
  subscribers: SubscriberView[];
}) {
  const [lookFor, setLookFor] = useState(criterion.lookForMarkdown);
  const [avoid, setAvoid] = useState(criterion.avoidMarkdown);
  const [minimumScore, setMinimumScore] = useState(
    qualityOptions.reduce((closest, option) =>
      Math.abs(option.value - criterion.minimumScore) <
      Math.abs(closest - criterion.minimumScore)
        ? option.value
        : closest,
    qualityOptions[0].value),
  );
  const [candidateCount, setCandidateCount] = useState(
    String(criterion.weeklyCandidateCount),
  );
  const [learningEnabled, setLearningEnabled] = useState(criterion.learningRate > 0);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [sourceEnabled, setSourceEnabled] = useState<Record<string, boolean>>(
    () => Object.fromEntries(sources.map((source) => [source.id, source.enabled])),
  );
  const [sourcePending, setSourcePending] = useState<string | null>(null);
  const [sourceMessage, setSourceMessage] = useState<{
    error: boolean;
    text: string;
  } | null>(null);

  function resetForm() {
    setLookFor(criterion.lookForMarkdown);
    setAvoid(criterion.avoidMarkdown);
    setMinimumScore(criterion.minimumScore);
    setCandidateCount(String(criterion.weeklyCandidateCount));
    setLearningEnabled(criterion.learningRate > 0);
    setSaved(false);
    setSaveError(null);
  }

  async function saveSettings() {
    setSaving(true);
    setSaved(false);
    setSaveError(null);
    try {
      const response = await fetch("/api/settings", {
        body: JSON.stringify({
          avoidMarkdown: avoid,
          explorationRate: criterion.explorationRate,
          learningRate: learningEnabled ? Math.max(criterion.learningRate, 0.01) : 0,
          lookForMarkdown: lookFor,
          minimumConfidence: criterion.minimumConfidence,
          minimumScore,
          signals: criterion.signals.length ? criterion.signals : fallbackSignals,
          weeklyCandidateCount: Number(candidateCount),
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Could not save settings");
      setSaved(true);
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : "Could not save settings");
    } finally {
      setSaving(false);
    }
  }

  async function setSourceIncluded(source: DiscoverySource, enabled: boolean) {
    setSourcePending(source.id);
    setSourceMessage(null);
    try {
      const response = await fetch("/api/sources", {
        body: JSON.stringify({ enabled, id: Number(source.id) }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        source?: DiscoverySource;
      };
      if (!response.ok || !payload.source) {
        throw new Error(payload.error ?? "Could not update this source");
      }
      setSourceEnabled((current) => ({
        ...current,
        [source.id]: payload.source?.enabled ?? enabled,
      }));
      setSourceMessage({
        error: false,
        text: enabled
          ? `${source.name} is now included.`
          : `${source.name} is no longer included.`,
      });
    } catch (caught) {
      setSourceMessage({
        error: true,
        text: caught instanceof Error ? caught.message : "Could not update this source",
      });
    } finally {
      setSourcePending(null);
    }
  }

  return (
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="Settings sections">
        <a href="#target">Target profile</a>
        <a href="#quality">Quality cutoff</a>
        <a href="#digest">Weekly brief</a>
        <a href="#sources">Source coverage</a>
        <a href="#adaptation">Review preferences</a>
      </nav>

      <div className="settings-content">
        <section className="settings-section" id="target">
          <header className="settings-section-header">
            <h2>Who should surface</h2>
            <p>Describe the people, stages, places, and areas that matter for this search.</p>
          </header>
          <div className="settings-text-grid">
            <label className="setting-textarea">
              <span>Look for</span>
              <textarea
                onChange={(event) => {
                  setLookFor(event.target.value);
                  setSaved(false);
                }}
                placeholder="For example: early technical builders in developer tools, biology, or hard science; high school through recent graduate; North America and Europe."
                rows={6}
                value={lookFor}
              />
            </label>
            <label className="setting-textarea">
              <span>Do not prioritize</span>
              <textarea
                onChange={(event) => {
                  setAvoid(event.target.value);
                  setSaved(false);
                }}
                placeholder="For example: profiles with broad existing recognition, or credentials without demonstrated work."
                rows={6}
                value={avoid}
              />
            </label>
          </div>
        </section>

        <section className="settings-section" id="quality">
          <header className="settings-section-header">
            <h2>Quality cutoff</h2>
            <p>Choose how much evidence a person needs before appearing in review.</p>
          </header>
          <div className="quality-options" role="radiogroup" aria-label="Quality cutoff">
            {qualityOptions.map((option) => (
              <label key={option.value}>
                <input
                  checked={minimumScore === option.value}
                  name="quality"
                  onChange={() => {
                    setMinimumScore(option.value);
                    setSaved(false);
                  }}
                  type="radio"
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
        </section>

        <section className="settings-section" id="digest">
          <header className="settings-section-header">
            <h2>Weekly brief</h2>
            <p>Control the review volume and who receives the current shortlist.</p>
          </header>
          <div className="settings-grid-two">
            <div className="setting-field">
              <label htmlFor="candidate-count">Candidates per brief</label>
              <select
                id="candidate-count"
                onChange={(event) => {
                  setCandidateCount(event.target.value);
                  setSaved(false);
                }}
                value={candidateCount}
              >
                <option value="8">8 · highly selective</option>
                <option value="12">12 · balanced</option>
                <option value="18">18 · broader review</option>
                <option value="25">25 · research mode</option>
              </select>
            </div>
            <div className="setting-field setting-field-readonly">
              <span>Delivery</span>
              <strong>Monday morning</strong>
              <small>Schedule changes are not available in this workspace yet.</small>
            </div>
          </div>
          <div className="subscriber-manager-wrap">
            <SubscriberManager initialSubscribers={subscribers} />
          </div>
        </section>

        <section className="settings-section" id="sources">
          <header className="settings-section-header">
            <h2>Source coverage</h2>
            <p>Choose which sources are included. Sources that still need setup stay off.</p>
          </header>
          {sources.length ? (
            <>
              <div className="settings-source-list" aria-busy={sourcePending !== null}>
                {sources.map((source) => {
                  const included = sourceEnabled[source.id] ?? false;
                  const pending = sourcePending === source.id;
                  const statusId = `source-${source.id}-status`;
                  return (
                    <label className="settings-source-toggle" key={source.id}>
                      <span className="settings-source-copy">
                        <strong>{source.name}</strong>
                        <small id={statusId}>
                          {pending ? "Updating" : included ? "Included" : "Not included"}
                        </small>
                      </span>
                      <span className="settings-source-control">
                        <input
                          aria-describedby={statusId}
                          checked={included}
                          disabled={sourcePending !== null}
                          onChange={(event) => setSourceIncluded(source, event.target.checked)}
                          role="switch"
                          type="checkbox"
                        />
                        <span aria-hidden="true" />
                      </span>
                    </label>
                  );
                })}
              </div>
              {sourceMessage ? (
                <p
                  className={sourceMessage.error ? "form-message form-message-error" : "form-message"}
                  role={sourceMessage.error ? "alert" : "status"}
                >
                  {sourceMessage.text}
                </p>
              ) : null}
            </>
          ) : (
            <div className="compact-empty-state compact-empty-state-left">
              <h2>No sources configured</h2>
              <p>Configure a source before running discovery.</p>
            </div>
          )}
        </section>

        <section className="settings-section" id="adaptation">
          <header className="settings-section-header">
            <h2>Review preferences</h2>
            <p>Decide whether explicit shortlist, watch, and pass decisions should influence future ordering.</p>
          </header>
          <label className="adaptation-toggle">
            <span>
              <strong>Adapt gradually to review decisions</strong>
              <small>Only explicit decisions are used; sensitive personal traits are excluded.</small>
            </span>
            <input
              checked={learningEnabled}
              onChange={(event) => {
                setLearningEnabled(event.target.checked);
                setSaved(false);
              }}
              type="checkbox"
            />
          </label>
          <button className="settings-reset" onClick={resetForm} type="button">
            <RotateCcw aria-hidden="true" /> Reset unsaved changes
          </button>
        </section>

        <div className="settings-sticky-save">
          <span
            className={saveError ? "settings-save-error" : undefined}
            role={saveError ? "alert" : "status"}
          >
            {saveError ?? (saved ? "Settings saved" : "Review changes before leaving")}
          </span>
          <button
            className="editorial-button editorial-button-dark"
            disabled={saving}
            onClick={saveSettings}
            type="button"
          >
            {saved ? <Check aria-hidden="true" /> : <Save aria-hidden="true" />}
            {saving ? "Saving" : saved ? "Saved" : "Save settings"}
          </button>
        </div>
      </div>
    </div>
  );
}
