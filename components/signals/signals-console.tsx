"use client";

import { RunDiscoveryButton } from "@/components/run-discovery-button";
import { AlertTriangle, CheckCircle2, CircleOff } from "lucide-react";

import type { SourceConfigurationView } from "./source-config";

export type SignalSourceView = {
  configuration: SourceConfigurationView;
  enabled: boolean;
  id: string;
  key: string;
  lastChecked: string | null;
  name: string;
  newCandidates: number;
  status: "working" | "needs-attention" | "not-configured" | "paused";
};

function SourceStatus({ status }: { status: SignalSourceView["status"] }) {
  if (status === "working") {
    return <span className="source-state state-working"><CheckCircle2 aria-hidden="true" /> Ready</span>;
  }
  if (status === "needs-attention") {
    return <span className="source-state state-attention"><AlertTriangle aria-hidden="true" /> Needs attention</span>;
  }
  return (
    <span className="source-state state-off">
      <CircleOff aria-hidden="true" />
      {status === "paused" ? "Paused" : "Setup needed"}
    </span>
  );
}

export function SignalsConsole({
  dataMode,
  sources,
}: {
  dataMode: "empty" | "live" | "unconfigured";
  sources: SignalSourceView[];
}) {
  return (
    <div className="sources-console">
      <section className="source-overview" aria-labelledby="source-overview-heading">
        <header className="source-toolbar">
          <div>
            <h2 id="source-overview-heading">Source coverage</h2>
            <p>See which sources are enabled, when each last succeeded, and how many candidates each added this week.</p>
          </div>
          <RunDiscoveryButton compact disabled={dataMode === "unconfigured"} />
        </header>

        {sources.length ? (
          <div className="source-list">
            <div className="source-list-heading" aria-hidden="true">
              <span>Source</span>
              <span>Status</span>
              <span>Last successful run</span>
              <span aria-label="Candidates added this week">Added</span>
            </div>
            {sources.map((source) => (
              <article className="source-row" key={source.id}>
                <strong>{source.name}</strong>
                <SourceStatus status={source.status} />
                <span>{source.lastChecked ?? "Never"}</span>
                <span className="source-new-count">{source.newCandidates}</span>
              </article>
            ))}
          </div>
        ) : (
          <div className="compact-empty-state compact-empty-state-left">
            <CircleOff aria-hidden="true" />
            <h2>{dataMode === "unconfigured" ? "Setup required" : "No sources configured"}</h2>
            <p>
              {dataMode === "unconfigured"
                ? "Finish workspace setup before choosing sources or running discovery."
                : "Choose the public sources you want to monitor in settings."}
            </p>
          </div>
        )}
      </section>

    </div>
  );
}
