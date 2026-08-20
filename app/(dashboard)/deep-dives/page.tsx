import { DeepDiveConsole } from "@/components/deep-dives/deep-dive-console";
import { SiteNav } from "@/components/site-nav";
import { getDataReadiness } from "@/lib/data/talent-radar";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Deep dives" };

export default function DeepDivesPage() {
  const readiness = getDataReadiness();

  return (
    <main className="app-main operator-page">
      <SiteNav />
      <div className="content-frame operator-shell">
        <header className="operator-header operator-header-compact">
          <div>
            <p className="eyebrow">Manual research</p>
            <h1>Research a roster</h1>
            <p>
              Import names from a public results or roster page, then check each
              person across the enabled sources.
            </p>
          </div>
        </header>
        <DeepDiveConsole disabled={readiness.dataMode === "unconfigured"} />
      </div>
    </main>
  );
}
