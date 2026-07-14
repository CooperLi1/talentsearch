"use client";

import { CandidateActions } from "@/components/candidates/candidate-actions";
import { SiteNav } from "@/components/site-nav";
import type { OperatorBriefFact } from "@/lib/candidates/operator-brief";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import Link from "next/link";
import { useRef } from "react";

export type DashboardCandidateView = {
  facts: OperatorBriefFact[];
  id: string;
  name: string;
  referralDisabled: boolean;
  slug: string;
  status: string;
};

function QueueRow({ candidate, rank }: { candidate: DashboardCandidateView; rank: number }) {
  return (
    <article className="queue-row">
      <span className="queue-rank" aria-label={`Rank ${rank}`}>{String(rank).padStart(2, "0")}</span>

      <div className="queue-person">
        <div className="queue-name-line">
          <h2><Link href={`/people/${candidate.slug}`}>{candidate.name}</Link></h2>
          <span className={`status-token status-${candidate.status}`}>
            {candidate.status}
          </span>
        </div>
      </div>

      <ul className="queue-facts">
        {candidate.facts.map((fact, factIndex) => (
          <li key={`${candidate.id}-fact-${factIndex}`}>
            <span>{fact.text}</span>
            {fact.sources.length ? (
              <span className="queue-fact-sources" aria-label="Sources">
                {fact.sources.map((source) => (
                  <a href={source.url} key={source.url} rel="noreferrer" target="_blank">
                    {source.label}<ArrowUpRight aria-hidden="true" />
                  </a>
                ))}
              </span>
            ) : null}
          </li>
        ))}
      </ul>

      <div className="queue-actions">
        <CandidateActions
          candidateId={candidate.id}
          referralDisabled={candidate.referralDisabled}
          status={candidate.status}
        />
        <Link className="queue-open" href={`/people/${candidate.slug}`}>
          Open <ArrowUpRight aria-hidden="true" />
        </Link>
      </div>
    </article>
  );
}

export function Dashboard({
  candidates,
  dataMode,
}: {
  candidates: DashboardCandidateView[];
  dataMode: "empty" | "live" | "unconfigured";
}) {
  const root = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      const media = gsap.matchMedia();
      media.add("(prefers-reduced-motion: no-preference)", () => {
        const headerItems = root.current?.querySelectorAll(
          ".operator-header > *",
        );
        const queueRows = root.current?.querySelectorAll(".queue-row");
        if (headerItems?.length) {
          gsap.from(headerItems, {
            duration: 0.55,
            ease: "power3.out",
            opacity: 0,
            stagger: 0.045,
            y: 10,
          });
        }
        if (queueRows?.length) {
          gsap.from(queueRows, {
            delay: 0.08,
            duration: 0.5,
            ease: "power3.out",
            opacity: 0,
            stagger: 0.055,
            y: 14,
          });
        }
      });
      return () => media.revert();
    },
    { scope: root },
  );

  return (
    <main className="app-main operator-page" ref={root}>
      <SiteNav />
      <div className="content-frame operator-shell">
        <header className="operator-header">
          <div>
            <p className="eyebrow">Weekly review</p>
            <h1>Candidate queue</h1>
            <p>
              The strongest recently discovered people, ordered for review.
            </p>
          </div>
          <div className="operator-header-actions">
            <Link className="editorial-button editorial-button-light" href="/people">
              <Search aria-hidden="true" /> Search people
            </Link>
          </div>
        </header>

        <section className="review-queue" id="candidates" aria-labelledby="queue-heading">
          <header className="queue-toolbar">
            <div>
              <h2 id="queue-heading">Review in order</h2>
              <span>{candidates.length ? `${candidates.length} ${candidates.length === 1 ? "person" : "people"}` : "No candidates waiting"}</span>
            </div>
            <Link href="/settings">
              <SlidersHorizontal aria-hidden="true" /> Review criteria
            </Link>
          </header>

          {candidates.length ? (
            <div className="queue-list">
              {candidates.map((candidate, index) => (
                <QueueRow candidate={candidate} key={candidate.id} rank={index + 1} />
              ))}
            </div>
          ) : dataMode === "unconfigured" ? (
            <div className="operator-empty-state operator-setup-state">
              <div className="empty-state-mark">
                <AlertTriangle aria-hidden="true" />
              </div>
              <div>
                <h2>Setup required.</h2>
                <p>
                  Finish workspace setup before running discovery or reviewing
                  candidates.
                </p>
              </div>
              <div className="empty-state-actions">
                <Link className="editorial-button editorial-button-dark" href="/settings">
                  <SlidersHorizontal aria-hidden="true" /> Open settings
                </Link>
              </div>
            </div>
          ) : (
            <div className="operator-empty-state">
              <div className="empty-state-mark">
                <CheckCircle2 aria-hidden="true" />
              </div>
              <div>
                <h2>No candidates are waiting.</h2>
                <p>
                  Run discovery to look for new evidence, or broaden the criteria if
                  the current cutoff is too selective.
                </p>
              </div>
              <div className="empty-state-actions">
                <Link className="editorial-button editorial-button-dark" href="/signals">
                  Review sources
                </Link>
              </div>
            </div>
          )}
        </section>

      </div>
    </main>
  );
}
