"use client";

import { SubscriberManager, type SubscriberView } from "@/components/settings/subscriber-manager";
import { SettingsSectionNav } from "@/components/settings/settings-section-nav";
import { DEFAULT_CRITERION_SIGNALS } from "@/lib/criteria/signals";
import type {
  CriterionCharacteristic,
  CriterionProfile,
  DiscoverySource,
} from "@/lib/domain/types";
import { Check, Plus, RotateCcw, Save, Sparkles, Trash2 } from "lucide-react";
import { useState } from "react";

const qualityOptions = [
  {
    description: "Surface promising people earlier for a wider manual review.",
    label: "Broad",
    value: 12,
  },
  {
    description: "Require multiple strong signals without hiding emerging work.",
    label: "Balanced",
    value: 18,
  },
  {
    description: "Only surface profiles with unusually strong public evidence.",
    label: "Selective",
    value: 28,
  },
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

const legacyCharacteristicKeys = new Set([
  "explicitHighSchool",
  "highSchoolTechInternship",
  "ioiRecognition",
  "targetSchool",
  "githubHighActivity",
  "hackerNewsHighActivity",
  "lowXFollowers",
  "activeButUndiscovered",
]);

function newCharacteristic(): CriterionCharacteristic {
  return {
    key: `custom_${crypto.randomUUID().replaceAll("-", "")}`,
    label: "",
    description: "",
    enabled: true,
    mode: "prefer",
    evidenceMatch: "all",
    values: [],
  };
}

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
  const [characteristics, setCharacteristics] = useState(
    criterion.characteristics,
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
  const includedSourceCount = Object.values(sourceEnabled).filter(Boolean).length;

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
    setCharacteristics(criterion.characteristics);
    setCriteriaInstruction("");
    setCriteriaDraftMessage(null);
    setLearningEnabled(criterion.learningRate > 0);
    setSaved(false);
    setSaveError(null);
  }

  async function saveSettings() {
    const invalidRule = characteristics.find(
      (rule) =>
        !rule.label.trim() ||
        (rule.enabled &&
          !legacyCharacteristicKeys.has(rule.key) &&
          !rule.values?.length),
    );
    if (invalidRule) {
      setSaveError(
        !invalidRule.label.trim()
          ? "Name every evidence characteristic before saving."
          : `Add at least one evidence term to ${invalidRule.label}.`,
      );
      return;
    }
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
          characteristics,
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
            <span className="settings-section-number">01</span>
            <div>
              <h2>Who should surface</h2>
              <p>Describe the people, stages, places, and areas that matter for this search.</p>
            </div>
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
                <span className="criteria-priority-name">
                  <input
                    aria-label={`Include ${signal.label}`}
                    checked={signal.enabled}
                    onChange={(event) => {
                      setSignals((current) =>
                        current.map((item) =>
                          item.key === signal.key
                            ? { ...item, enabled: event.target.checked }
                            : item,
                        ),
                      );
                      setSaved(false);
                    }}
                    type="checkbox"
                  />
                  <span>
                    <strong>{signal.label}</strong>
                    <small>{signal.description}</small>
                  </span>
                </span>
                <input
                  aria-label={`${signal.label} weight`}
                  disabled={!signal.enabled}
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
          <div className="criteria-characteristics">
            <div className="criteria-priorities-heading criteria-characteristics-heading">
              <div>
                <h3>Evidence characteristics</h3>
                <p>
                  Create your own checks using words or exact phrases that must
                  appear in cited evidence. Prefer changes ordering; require
                  removes non-matches.
                </p>
              </div>
              <button
                className="editorial-button editorial-button-light"
                disabled={characteristics.length >= 20}
                onClick={() => {
                  setCharacteristics((current) => [
                    ...current,
                    newCharacteristic(),
                  ]);
                  setSaved(false);
                  setSaveError(null);
                }}
                type="button"
              >
                <Plus aria-hidden="true" /> Add characteristic
              </button>
            </div>
            {characteristics.length ? (
              <div className="criteria-characteristic-list">
                {characteristics.map((rule) => (
                  <div className="criteria-characteristic" key={rule.key}>
                    <div className="criteria-characteristic-header">
                      <label className="criteria-characteristic-toggle">
                        <input
                          aria-label={`Enable ${rule.label || "new characteristic"}`}
                          checked={rule.enabled}
                          onChange={(event) => {
                            setCharacteristics((current) =>
                              current.map((item) =>
                                item.key === rule.key
                                  ? { ...item, enabled: event.target.checked }
                                  : item,
                              ),
                            );
                            setSaved(false);
                          }}
                          type="checkbox"
                        />
                        <span>
                          <strong>{rule.label || "New characteristic"}</strong>
                          <small>{rule.enabled ? "Included in ranking" : "Paused"}</small>
                        </span>
                      </label>
                      <button
                        aria-label={`Remove ${rule.label || "new characteristic"}`}
                        className="criteria-characteristic-remove"
                        onClick={() => {
                          setCharacteristics((current) =>
                            current.filter((item) => item.key !== rule.key),
                          );
                          setSaved(false);
                          setSaveError(null);
                        }}
                        type="button"
                      >
                        <Trash2 aria-hidden="true" />
                      </button>
                    </div>
                    <label className="criteria-characteristic-field">
                      <span>Name</span>
                      <input
                        aria-invalid={!rule.label.trim()}
                        maxLength={120}
                        onChange={(event) => {
                          setCharacteristics((current) =>
                            current.map((item) =>
                              item.key === rule.key
                                ? { ...item, label: event.target.value }
                                : item,
                            ),
                          );
                          setSaved(false);
                          setSaveError(null);
                        }}
                        placeholder="High-school robotics builder"
                        type="text"
                        value={rule.label}
                      />
                    </label>
                    <label className="criteria-characteristic-field">
                      <span>Behavior</span>
                      <select
                        disabled={!rule.enabled}
                        onChange={(event) => {
                          const mode = event.target.value === "require" ? "require" : "prefer";
                          setCharacteristics((current) =>
                            current.map((item) =>
                              item.key === rule.key ? { ...item, mode } : item,
                            ),
                          );
                          setSaved(false);
                        }}
                        value={rule.mode}
                      >
                        <option value="prefer">Prefer matches</option>
                        <option value="require">Require a match</option>
                      </select>
                    </label>
                    <label className="criteria-characteristic-field criteria-characteristic-field-wide">
                      <span>Evidence terms · one word or phrase per line</span>
                      <textarea
                        aria-invalid={
                          rule.enabled &&
                          !legacyCharacteristicKeys.has(rule.key) &&
                          !rule.values?.length
                        }
                        disabled={!rule.enabled}
                        maxLength={10_000}
                        onChange={(event) => {
                          const values = event.target.value
                            .split(/\n+/u)
                            .map((value) => value.trim())
                            .filter(Boolean)
                            .slice(0, 50);
                          setCharacteristics((current) =>
                            current.map((item) =>
                              item.key === rule.key ? { ...item, values } : item,
                            ),
                          );
                          setSaved(false);
                          setSaveError(null);
                        }}
                        placeholder={"high school\nrobotics\nbuilt"}
                        rows={3}
                        value={(rule.values ?? []).join("\n")}
                      />
                    </label>
                    <label className="criteria-characteristic-field">
                      <span>Term matching</span>
                      <select
                        disabled={!rule.enabled}
                        onChange={(event) => {
                          const evidenceMatch = event.target.value === "any" ? "any" : "all";
                          setCharacteristics((current) =>
                            current.map((item) =>
                              item.key === rule.key ? { ...item, evidenceMatch } : item,
                            ),
                          );
                          setSaved(false);
                        }}
                        value={rule.evidenceMatch ?? "all"}
                      >
                        <option value="all">Match all terms</option>
                        <option value="any">Match any term</option>
                      </select>
                    </label>
                    <label className="criteria-characteristic-field">
                      <span>Note · optional</span>
                      <input
                        maxLength={500}
                        onChange={(event) => {
                          setCharacteristics((current) =>
                            current.map((item) =>
                              item.key === rule.key
                                ? { ...item, description: event.target.value }
                                : item,
                            ),
                          );
                          setSaved(false);
                        }}
                        placeholder="Why this matters to the search"
                        type="text"
                        value={rule.description}
                      />
                    </label>
                  </div>
                ))}
              </div>
            ) : (
              <div className="criteria-characteristic-empty">
                <strong>No evidence characteristics yet.</strong>
                <span>Add one when you want a precise cited-evidence preference or requirement.</span>
              </div>
            )}
          </div>
        </section>

        <section className="settings-section" id="quality">
          <header className="settings-section-header">
            <span className="settings-section-number">02</span>
            <div>
              <h2>Quality cutoff</h2>
              <p>Choose how much evidence a person needs before appearing in review.</p>
            </div>
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
                <span className="quality-option-copy">
                  <span>
                    <strong>{option.label}</strong>
                    <small>Score {option.value}+</small>
                  </span>
                  <p>{option.description}</p>
                </span>
              </label>
            ))}
          </div>
        </section>

        <section className="settings-section" id="digest">
          <header className="settings-section-header">
            <span className="settings-section-number">03</span>
            <div>
              <h2>Brief delivery</h2>
              <p>Choose the days, send time, review volume, and recipient list.</p>
            </div>
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
            <span className="settings-section-number">04</span>
            <div>
              <h2>Source coverage</h2>
              <p>Choose which sources are included. Sources that still need setup stay off.</p>
            </div>
            <span className="settings-section-count">
              {includedSourceCount} of {sources.length} active
            </span>
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
            <span className="settings-section-number">05</span>
            <div>
              <h2>Review preferences</h2>
              <p>Decide whether explicit shortlist, watch, and pass decisions should influence future ordering.</p>
            </div>
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
        </section>

        <div className="settings-sticky-save">
          <div className="settings-save-state">
            <span className={saved ? "settings-save-indicator settings-save-indicator-saved" : "settings-save-indicator"} />
            <span
              className={saveError ? "settings-save-error" : undefined}
              role={saveError ? "alert" : "status"}
            >
              <strong>{saveError ? "Could not save" : saved ? "Settings saved" : "Unsaved workspace settings"}</strong>
              <small>{saveError ?? (saved ? "Your next run will use these settings." : "Source switches save separately and apply immediately.")}</small>
            </span>
          </div>
          <div className="settings-save-actions">
            <button className="settings-reset" onClick={resetForm} type="button">
              <RotateCcw aria-hidden="true" /> Reset
            </button>
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
    </div>
  );
}
