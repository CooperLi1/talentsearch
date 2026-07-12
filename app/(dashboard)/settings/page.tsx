import { SiteNav } from "@/components/site-nav";
import { TuningPanel } from "@/components/settings/tuning-panel";
import { getDashboardData } from "@/lib/data/talent-radar";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const data = await getDashboardData();
  const subscribers = data.subscribers.map((subscriber) => ({
    createdAt: new Intl.DateTimeFormat("en-US", {
      month: "short",
      year: "numeric",
    }).format(new Date(subscriber.createdAt)),
    email: subscriber.email,
    deliveryStatus: subscriber.deliveryStatus,
    id: subscriber.id,
    isActive: subscriber.status === "active",
    lastSentAt: subscriber.lastSentAt
      ? new Intl.DateTimeFormat("en-US", {
          day: "numeric",
          month: "short",
        }).format(new Date(subscriber.lastSentAt))
      : null,
  }));

  return (
    <main className="app-main operator-page settings-page">
      <SiteNav />
      <div className="content-frame operator-shell">
        <header className="operator-header operator-header-compact">
          <div>
            <p className="eyebrow">Workspace settings</p>
            <h1>Review criteria</h1>
            <p>Set who should surface, how selective the queue is, and who receives the brief.</p>
          </div>
        </header>
        {data.dataMode === "unconfigured" ? (
          <div className="operator-empty-state operator-setup-state settings-setup-state">
            <div>
              <h2>Setup required.</h2>
              <p>Finish workspace setup before changing criteria or digest recipients.</p>
            </div>
          </div>
        ) : (
          <TuningPanel
            criterion={data.criterion}
            sources={data.sources}
            subscribers={subscribers}
          />
        )}
      </div>
    </main>
  );
}
