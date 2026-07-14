"use client";

import { SubscriberManager, type SubscriberView } from "@/components/settings/subscriber-manager";
import { SettingsSectionNav } from "@/components/settings/settings-section-nav";
import { DEFAULT_CRITERION_SIGNALS } from "@/lib/criteria/signals";
import type { CriterionProfile, DiscoverySource } from "@/lib/domain/types";
import { Check, RotateCcw, Save, Sparkles } from "lucide-react";
import { useState } from "react";

const qualityOptions = [
  { label: "Broad · more people to inspect", value: 12 },
  { label: "Balanced · strong evidence", value: 18 },
  { label: "Selective · exceptional evidence", value: 28 },
];

const deliveryTimes = Array.from({ length: 24 * 4 }, (_, index) => {
  const hour = Math.floor(index / 4);
  const minute = (index % 4) * 15;
  return {
    label: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} UTC`,
    value: hour * 60 + minute,
  };
});

const deliveryDays = [
  { label: "Mon", value: 1 },
  { label: "Tue", value: 2 },
  { label: "Wed", value: 3 },
  { label: "Thu", value: 4 },
  { label: "Fri", value: 5 },
  { label: "Sat", value: 6 },
  { label: "Sun", value: 0 },
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
  const [digestDaysOfWeek, setDigestDaysOfWeek] = useState(criterion.digestDaysOfWeek);
  const [digestDeliveryHourUtc, setDigestDeliveryHourUtc] = useState(
    criterion.digestDeliveryHourUtc,
  );
  const [digestDeliveryMinuteUtc, setDigestDeliveryMinuteUtc] = useState(
    criterion.digestDeliveryMinuteUtc,
  );
  const [digestPreparationLeadHours, setDigestPreparationLeadHours] = useState(
    criterion.digestPreparationLeadHours,
  );
  const [signals, setSignals] = useState(
    criterion.signals.length ? criterion.signals : DEFAULT_CRITERION_SIGNALS,
  );
  const [criteriaInstruction, setCriteriaInstruction] = useState("");
  const [draftingCriteria, setDraftingCriteria] = useState(false);
  const [criteriaDraftMessage, setCriteriaDraftMessage] = useState<string | null>(null);
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
    setDigestDaysOfWeek(criterion.digestDaysOfWeek);
    setDigestDeliveryHourUtc(criterion.digestDeliveryHourUtc);
    setDigestDeliveryMinuteUtc(criterion.digestDeliveryMinuteUtc);
    setDigestPreparationLeadHours(criterion.digestPreparationLeadHours);
    setSignals(criterion.signals.length ? criterion.signals : DEFAULT_CRITERION_SIGNALS);
    setCriteriaInstruction("");
    setCriteriaDraftMessage(null);
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
          digestCadence: criterion.digestCadence,
          digestDaysOfWeek,
          digestDeliveryHourUtc,
          digestDeliveryMinuteUtc,
          digestPreparationLeadHours,
          explorationRate: criterion.explorationRate,
          learningRate: learningEnabled ? Math.max(criterion.learningRate, 0.01) : 0,
          lookForMarkdown: lookFor,
          minimumConfidence: criterion.minimumConfidence,
          minimumScore,
          signals,
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

  async function draftCriteria() {
    setDraftingCriteria(true);
    setCriteriaDraftMessage(null);
    setSaveError(null);
    try {
      const response = await fetch("/api/settings/suggest", {
        body: JSON.stringify({ instruction: criteriaInstruction }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => ({}))) as {
        draft?: Pick<CriterionProfile, "lookForMarkdown" | "avoidMarkdown" | "minimumScore" | "signals">;
        error?: string;
      };
      if (!response.ok || !payload.draft) {
        throw new Error(payload.error ?? "Could not draft criteria");
      }
      setLookFor(payload.draft.lookForMarkdown);
      setAvoid(payload.draft.avoidMarkdown);
      setMinimumScore(payload.draft.minimumScore);
      setSignals(payload.draft.signals);
      setSaved(false);
      setCriteriaDraftMessage("Draft applied. Review it before saving.");
    } catch (caught) {
      setCriteriaDraftMessage(caught instanceof Error ? caught.message : "Could not draft criteria");
    } finally {
      setDraftingCriteria(false);
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
      <SettingsSectionNav />

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
          <div className="criteria-drafter">
            <div className="criteria-drafter-copy">
              <span>Draft from an instruction</span>
              <p>Describe the change you want. The draft updates the target, cutoff, and weights, but nothing is saved until you approve it.</p>
            </div>
            <textarea
              aria-label="Instruction for criteria draft"
              onChange={(event) => setCriteriaInstruction(event.target.value)}
              placeholder="Example: favor technically difficult projects and recent momentum; broaden toward hardware and computational biology."
              rows={3}
              value={criteriaInstruction}
            />
            <div className="criteria-drafter-action">
              <button
                className="editorial-button editorial-button-light"
                disabled={draftingCriteria || criteriaInstruction.trim().length < 10}
                onClick={draftCriteria}
                type="button"
              >
                <Sparkles aria-hidden="true" />
                {draftingCriteria ? "Drafting" : "Draft changes"}
              </button>
              {criteriaDraftMessage ? <span role="status">{criteriaDraftMessage}</span> : null}
            </div>
          </div>
          <div className="criteria-priorities">
            <div className="criteria-priorities-heading">
              <h3>Priority weights</h3>
              <p>Weights are normalized when you save.</p>
            </div>
            {signals.map((signal) => (
              <label className="criteria-priority-row" key={signal.key}>
                <span>{signal.label}</span>
                <input
                  aria-label={`${signal.label} weight`}
                  max="1"
                  min="0"
                  onChange={(event) => {
                    const weight = Number(event.target.value);
                    setSignals((current) => current.map((item) => item.key === signal.key ? { ...item, weight } : item));
                    setSaved(false);
                  }}
                  step="0.01"
                  type="range"
                  value={signal.weight}
                />
                <output>{Math.round(signal.weight * 100)}%</output>
              </label>
            ))}
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
            <h2>Brief delivery</h2>
            <p>Choose the days, send time, review volume, and recipient list.</p>
          </header>
          <div className="settings-grid-three">
            <label className="setting-field" htmlFor="candidate-count">
              <span>Candidates per brief</span>
              <input
                id="candidate-count"
                max="100"
                min="1"
                onChange={(event) => {
                  setCandidateCount(event.target.value);
                  setSaved(false);
                }}
                type="number"
                value={candidateCount}
              />
              <small>Choose between 1 and 100.</small>
            </label>
            <label className="setting-field" htmlFor="digest-delivery-time">
              <span>Send time</span>
              <select
                id="digest-delivery-time"
                onChange={(event) => {
                  const totalMinutes = Number(event.target.value);
                  setDigestDeliveryHourUtc(Math.floor(totalMinutes / 60));
                  setDigestDeliveryMinuteUtc(totalMinutes % 60);
                  setSaved(false);
                }}
                value={digestDeliveryHourUtc * 60 + digestDeliveryMinuteUtc}
              >
                {deliveryTimes.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <small>Times use UTC and run in 15-minute windows.</small>
            </label>
            <label className="setting-field" htmlFor="digest-preparation-lead">
              <span>Prepare ahead</span>
              <input
                id="digest-preparation-lead"
                max="12"
                min="1"
                onChange={(event) => {
                  setDigestPreparationLeadHours(Number(event.target.value));
                  setSaved(false);
                }}
                type="number"
                value={digestPreparationLeadHours}
              />
              <small>Hours before send time; choose 1–12.</small>
            </label>
          </div>
          <fieldset className="delivery-days">
            <legend>Send on</legend>
            <div className="delivery-day-options">
              {deliveryDays.map((day) => (
                <label key={day.value}>
                  <input
                    checked={digestDaysOfWeek.includes(day.value)}
                    onChange={(event) => {
                      setDigestDaysOfWeek((current) => event.target.checked
                        ? [...new Set([...current, day.value])]
                        : current.length > 1
                          ? current.filter((value) => value !== day.value)
                          : current);
                      setSaved(false);
                    }}
                    type="checkbox"
                  />
                  <span>{day.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
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
