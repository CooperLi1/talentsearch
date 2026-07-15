import { PeopleSearch } from "@/components/people/people-search";
import { SiteNav } from "@/components/site-nav";
import {
  DataNotConfiguredError,
  getDataReadiness,
  listCandidates,
} from "@/lib/data/talent-radar";
import { toPeopleCandidateView } from "@/lib/candidates/people-view";
import type { Candidate } from "@/lib/domain/types";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Search" };

export default async function PeoplePage() {
  let readiness = getDataReadiness();
  let candidates: Candidate[] = [];
  try {
    candidates = await listCandidates({ limit: 250 });
  } catch (error) {
    if (!(error instanceof DataNotConfiguredError)) throw error;
    readiness = { ...readiness, dataMode: "unconfigured" };
  }

  return (
    <main className="app-main operator-page">
      <SiteNav />
      <div className="content-frame operator-shell">
        <header className="operator-header operator-header-compact">
          <div>
            <p className="eyebrow">Candidate records</p>
            <h1>Search people</h1>
            <p>Search by a person&apos;s work, background, or linked evidence.</p>
          </div>
        </header>
        <PeopleSearch
          candidates={candidates.map(toPeopleCandidateView)}
          dataMode={readiness.dataMode}
        />
      </div>
    </main>
  );
}
