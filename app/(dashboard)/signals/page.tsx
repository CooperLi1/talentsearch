import {
  SignalsConsole,
  type SignalSourceView,
} from "@/components/signals/signals-console";
import { SourceConfigEditor } from "@/components/signals/source-config-editor";
import { normalizeSourceConfiguration } from "@/components/signals/source-config";
import { SiteNav } from "@/components/site-nav";
import { getDashboardData } from "@/lib/data/talent-radar";
import type { DiscoverySource } from "@/lib/domain/types";
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
    configuration: normalizeSourceConfiguration(source.config),
    id: source.id,
    enabled: source.enabled,
    key: source.key,
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

export default async function SignalsPage() {
  const data = await getDashboardData();
  const sources = data.sources.map(toSource);

  return (
    <main className="app-main operator-page">
      <SiteNav />
      <div className="content-frame operator-shell">
        <header className="operator-header operator-header-compact">
          <div>
            <p className="eyebrow">Discovery sources</p>
            <h1>Sources</h1>
            <p>Choose where discovery runs and see whether each source is working.</p>
          </div>
        </header>
        <SignalsConsole dataMode={data.dataMode} sources={sources} />
        <SourceConfigEditor
          dataMode={data.dataMode}
          sources={sources}
        />
      </div>
    </main>
  );
}
