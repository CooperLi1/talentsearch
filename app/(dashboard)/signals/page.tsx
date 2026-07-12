import {
  SignalsConsole,
  type SignalEdgeView,
  type SignalNodeView,
  type SignalSourceView,
} from "@/components/signals/signals-console";
import { SiteNav } from "@/components/site-nav";
import { getDashboardData } from "@/lib/data/talent-radar";
import type { Candidate, DiscoverySource } from "@/lib/domain/types";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Sources" };

function formatDate(value: string | null) {
  if (!value) return null;
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
  }).format(new Date(value));
}

function toSource(source: DiscoverySource): SignalSourceView {
  return {
    id: source.id,
    lastChecked: formatDate(source.lastSuccessAt),
    name: source.name,
    newCandidates: source.discoveredThisWeek,
    status:
      source.status === "degraded"
        ? "needs-attention"
        : source.enabled && source.status === "active"
          ? "working"
          : "not-configured",
  };
}

function buildGraph(candidates: Candidate[]) {
  const visible = candidates.slice(0, 8);
  const slugToId = new Map(visible.map((candidate) => [candidate.slug, candidate.id]));
  const nodes: SignalNodeView[] = visible.map((candidate) => ({
    id: candidate.id,
    initials: candidate.initials,
    label: candidate.name,
  }));
  const seen = new Set<string>();
  const edges: SignalEdgeView[] = [];

  for (const candidate of visible) {
    for (const connection of candidate.connections) {
      if (!connection.candidateSlug) continue;
      const target = slugToId.get(connection.candidateSlug);
      if (!target || target === candidate.id) continue;
      const key = [candidate.id, target].sort().join(":");
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        from: candidate.id,
        label: connection.relationship,
        strength: connection.strength,
        to: target,
      });
    }
  }

  return { edges, nodes };
}

export default async function SignalsPage() {
  const data = await getDashboardData();
  const graph = buildGraph(data.candidates.slice(0, 40));

  return (
    <main className="app-main operator-page">
      <SiteNav />
      <div className="content-frame operator-shell">
        <header className="operator-header operator-header-compact">
          <div>
            <p className="eyebrow">Discovery sources</p>
            <h1>Sources and connections</h1>
            <p>Check coverage, resolve source issues, and inspect verified graph paths.</p>
          </div>
        </header>
        <SignalsConsole
          edges={graph.edges}
          dataMode={data.dataMode}
          nodes={graph.nodes}
          sources={data.sources.map(toSource)}
        />
      </div>
    </main>
  );
}
