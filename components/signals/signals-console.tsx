"use client";

import { RunDiscoveryButton } from "@/components/run-discovery-button";
import { AlertTriangle, CheckCircle2, CircleOff, Network } from "lucide-react";

export type SignalNodeView = {
  id: string;
  initials: string;
  label: string;
};

export type SignalEdgeView = {
  from: string;
  label: string;
  strength: number;
  to: string;
};

export type SignalSourceView = {
  id: string;
  lastChecked: string | null;
  name: string;
  newCandidates: number;
  status: "working" | "needs-attention" | "not-configured";
};

const positions = [
  { x: 48, y: 46 },
  { x: 19, y: 22 },
  { x: 79, y: 19 },
  { x: 24, y: 77 },
  { x: 76, y: 74 },
  { x: 48, y: 84 },
  { x: 11, y: 52 },
  { x: 89, y: 48 },
];

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
  edges,
  dataMode,
  nodes,
  sources,
}: {
  edges: SignalEdgeView[];
  dataMode: "empty" | "live" | "unconfigured";
  nodes: SignalNodeView[];
  sources: SignalSourceView[];
}) {
  const visibleNodes = nodes.slice(0, positions.length);
  const nodeMap = new Map(
    visibleNodes.map((node, index) => [node.id, positions[index]]),
  );
  const visibleEdges = edges.filter(
    (edge) => nodeMap.has(edge.from) && nodeMap.has(edge.to),
  );

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

      <section className="connection-overview" aria-labelledby="connection-overview-heading">
        <header className="source-toolbar">
          <div>
            <h2 id="connection-overview-heading">Verified connections</h2>
            <p>Only candidate-to-candidate paths backed by stored evidence.</p>
          </div>
          <Network aria-hidden="true" />
        </header>

        {visibleNodes.length ? (
          <div className="network-canvas" aria-label="Verified candidate connections">
            <svg className="network-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
              {visibleEdges.map((edge) => {
                const from = nodeMap.get(edge.from)!;
                const to = nodeMap.get(edge.to)!;
                return (
                  <line
                    className={edge.strength >= 0.75 ? "network-line-hot" : "network-line"}
                    key={`${edge.from}-${edge.to}-${edge.label}`}
                    x1={from.x}
                    x2={to.x}
                    y1={from.y}
                    y2={to.y}
                  />
                );
              })}
            </svg>
            {visibleNodes.map((node, index) => (
              <span
                className={`network-person network-node-position-${index + 1}`}
                key={node.id}
              >
                <span>{node.initials}</span>
                <strong>{node.label}</strong>
              </span>
            ))}
            {!visibleEdges.length ? (
              <p className="network-empty-note">No verified paths between these candidates yet.</p>
            ) : null}
          </div>
        ) : (
          <div className="compact-empty-state compact-empty-state-left">
            <Network aria-hidden="true" />
            <h2>No candidate graph yet</h2>
            <p>Connections appear after identities and shared work are verified.</p>
          </div>
        )}
      </section>
    </div>
  );
}
