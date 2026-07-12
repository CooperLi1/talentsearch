"use client";

import { Radar } from "lucide-react";
import { useState } from "react";

export function RunDiscoveryButton({
  compact = false,
  disabled = false,
}: {
  compact?: boolean;
  disabled?: boolean;
}) {
  const [state, setState] = useState<"idle" | "running" | "done" | "error">(
    "idle",
  );

  async function runDiscovery() {
    if (disabled || state === "running") return;
    setState("running");

    try {
      const response = await fetch("/api/discovery/run", { method: "POST" });
      if (!response.ok) throw new Error("Discovery failed");
      setState("done");
      window.setTimeout(() => setState("idle"), 2400);
    } catch {
      setState("error");
      window.setTimeout(() => setState("idle"), 3000);
    }
  }

  const label =
    state === "running"
      ? "Scanning"
      : state === "done"
        ? "Scan queued"
        : state === "error"
          ? "Try again"
          : compact
            ? "Run scan"
            : "Run discovery";

  return (
    <button
      className="nav-button"
      disabled={disabled || state === "running"}
      onClick={runDiscovery}
      title={disabled ? "Finish workspace setup before running discovery" : undefined}
      type="button"
    >
      <Radar aria-hidden="true" className={state === "running" ? "animate-spin" : ""} />
      {label}
    </button>
  );
}
