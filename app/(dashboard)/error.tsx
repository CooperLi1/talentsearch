"use client";

import { SiteNav } from "@/components/site-nav";
import { CircleOff } from "lucide-react";
import Link from "next/link";

export default function DashboardError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="app-main operator-page">
      <SiteNav />
      <div className="content-frame operator-shell">
        <section className="compact-empty-state" aria-labelledby="workspace-error-heading">
          <CircleOff aria-hidden="true" />
          <h1 id="workspace-error-heading">Workspace setup is incomplete</h1>
          <p>Finish the connection setup, then try this screen again.</p>
          <div className="operator-header-actions">
            <button className="editorial-button editorial-button-dark" onClick={reset} type="button">
              Try again
            </button>
            <Link className="editorial-button editorial-button-light" href="/settings">
              Open settings
            </Link>
          </div>
        </section>
      </div>
    </main>
  );
}
