"use client";

import { Bookmark, Check, Eye, X } from "lucide-react";
import { useState } from "react";

const decisions = [
  { icon: Bookmark, label: "Shortlist", value: "save" },
  { icon: Eye, label: "Watch", value: "watch" },
  { icon: X, label: "Pass", value: "pass" },
] as const;

export function CandidateActions({
  candidateId,
  status,
}: {
  candidateId: string;
  status?: string;
}) {
  const [selected, setSelected] = useState<string | null>(() =>
    status === "saved"
      ? "save"
      : status === "watching"
        ? "watch"
        : status === "passed"
          ? "pass"
          : null,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(value: string) {
    const previous = selected;
    setSaving(true);
    setError(null);
    setSelected(value);
    try {
      const response = await fetch("/api/feedback", {
        body: JSON.stringify({ action: value, candidateId }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      if (!response.ok) throw new Error("Unable to save");
    } catch {
      setSelected(previous);
      setError("Decision was not saved");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="candidate-action-wrap">
      <div className="candidate-decision-row" aria-label="Candidate decision" role="group">
        {decisions.map(({ icon: Icon, label, value }) => (
          <button
            aria-pressed={selected === value}
            className={selected === value ? "candidate-decision candidate-decision-active" : "candidate-decision"}
            disabled={saving}
            key={value}
            onClick={() => decide(value)}
            type="button"
          >
            {selected === value ? <Check aria-hidden="true" /> : <Icon aria-hidden="true" />}
            {label}
          </button>
        ))}
      </div>
      {error ? <span className="candidate-action-error" role="status">{error}</span> : null}
    </div>
  );
}
