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
  status: "working" | "needs-attention" | "not-configured";
};

function SourceStatus({ status }: { status: SignalSourceView["status"] }) {
  if (status === "working") {
    return <span className="source-state state-working"><CheckCircle2 aria-hidden="true" /> Working</span>;
  }
  if (status === "needs-attention") {
    return <span className="source-state state-attention"><AlertTriangle aria-hidden="true" /> Needs attention</span>;
  }
  return <span className="source-state state-off"><CircleOff aria-hidden="true" /> Not configured</span>;
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
            <p>Last check, new candidates, and anything requiring attention.</p>
          </div>
          <RunDiscoveryButton compact disabled={dataMode === "unconfigured"} />
        </header>

        {sources.length ? (
          <div className="source-list">
            <div className="source-list-heading" aria-hidden="true">
              <span>Source</span>
              <span>Status</span>
              <span>Last checked</span>
              <span>New</span>
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
