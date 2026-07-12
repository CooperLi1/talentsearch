import { SiteNav } from "@/components/site-nav";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";

export default function NotFound() {
  return (
    <main className="app-main workspace-page">
      <SiteNav />
      <div className="content-frame empty-state">
        <p className="eyebrow">Candidate not found</p>
        <h1>This profile is unavailable.</h1>
        <p>It may have been merged after an identity review or removed from the workspace.</p>
        <Link className="editorial-button editorial-button-dark" href="/people">
          <ArrowLeft aria-hidden="true" /> Return to people
        </Link>
      </div>
    </main>
  );
}
