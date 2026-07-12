"use client";

import { CandidateActions } from "@/components/candidates/candidate-actions";
import { SiteNav } from "@/components/site-nav";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  Clock3,
  Network,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import Link from "next/link";
import { useRef } from "react";

export type DashboardCandidateView = {
  confidence: number;
  domains: string[];
  evidence: {
    date: string;
    source: string;
    title: string;
    url: string;
  } | null;
  graphReason: string | null;
  headline: string;
  id: string;
  identityWarning: string | null;
  initials: string;
  location: string;
  name: string;
  recency: string;
  score: number;
  slug: string;
  stage: string;
  status: string;
  unusualReason: string;
  whyNow: string;
};

function QueueRow({ candidate }: { candidate: DashboardCandidateView }) {
  return (
    <article className="queue-row">
      <div className="identity-mark" aria-hidden="true">
        {candidate.initials}
      </div>

      <div className="queue-person">
        <div className="queue-name-line">
          <h2>{candidate.name}</h2>
          <span className={`status-token status-${candidate.status}`}>
            {candidate.status}
          </span>
        </div>
        <p className="queue-stage">
          {[candidate.stage, candidate.location].filter(Boolean).join(" · ") ||
            "Stage and location not verified"}
        </p>
        <p className="queue-thesis">{candidate.headline}</p>
        <div className="queue-tags" aria-label="Candidate focus areas">
          {candidate.domains.slice(0, 3).map((domain) => (
            <span key={domain}>{domain}</span>
          ))}
        </div>
      </div>

      <div className="queue-reason">
        <span className="queue-cell-label">Why surfaced now · {candidate.recency}</span>
        <p>{candidate.whyNow}</p>
        {candidate.evidence ? (
          <a
            className="queue-evidence-link"
            href={candidate.evidence.url}
            rel="noreferrer"
            target="_blank"
          >
            <strong>{candidate.evidence.title}</strong>
            <span>{candidate.evidence.source} · {candidate.evidence.date}</span>
            <ArrowUpRight aria-hidden="true" />
          </a>
        ) : (
          <span className="queue-evidence-missing">No source link attached yet</span>
        )}
      </div>

      <div className="queue-proof">
        <span className="queue-cell-label">Why it stands out</span>
        <p>{candidate.unusualReason}</p>
        {candidate.graphReason ? (
          <span className="queue-graph-reason">
            <Network aria-hidden="true" /> {candidate.graphReason}
          </span>
        ) : null}
        {candidate.identityWarning ? (
          <span className="identity-warning">
            <AlertTriangle aria-hidden="true" /> {candidate.identityWarning}
          </span>
        ) : null}
      </div>

      <div className="queue-score">
        <strong>{candidate.score.toFixed(1)}</strong>
        <small>Review score</small>
        <span>Identity confidence {Math.round(candidate.confidence * 100)}%</span>
      </div>

      <div className="queue-actions">
        <CandidateActions
          candidateId={candidate.id}
          referralDisabled={Boolean(candidate.identityWarning) || /high.?school|minor/i.test(candidate.stage)}
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
  const identityChecks = candidates.filter((candidate) => candidate.identityWarning).length;
  const newCandidates = candidates.filter((candidate) => candidate.status === "new").length;
  const verifiedCandidates = candidates.filter((candidate) => candidate.confidence >= 0.9).length;

  useGSAP(
    () => {
      const media = gsap.matchMedia();
      media.add("(prefers-reduced-motion: no-preference)", () => {
        const headerItems = root.current?.querySelectorAll(
          ".operator-header > *, .queue-summary > *",
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
              New evidence, ordered for review. Verify the source, make a decision,
              and move on.
            </p>
          </div>
          <div className="operator-header-actions">
            <Link className="editorial-button editorial-button-light" href="/people">
              <Search aria-hidden="true" /> Search people
            </Link>
          </div>
        </header>

        <section className="queue-summary" aria-label="Queue summary">
          <div>
            <span>Ready to review</span>
            <strong>{candidates.length}</strong>
          </div>
          <div>
            <span>New</span>
            <strong>{newCandidates}</strong>
          </div>
          <div>
            <span>High-confidence identity</span>
            <strong>{verifiedCandidates}</strong>
          </div>
          <div className={identityChecks ? "summary-attention" : ""}>
            <span>Identity checks</span>
            <strong>{identityChecks}</strong>
          </div>
        </section>

        <section className="review-queue" id="candidates" aria-labelledby="queue-heading">
          <header className="queue-toolbar">
            <div>
              <h2 id="queue-heading">Review in order</h2>
              <span>{candidates.length ? "Highest-priority evidence first" : "No candidates waiting"}</span>
            </div>
            <Link href="/settings">
              <SlidersHorizontal aria-hidden="true" /> Review criteria
            </Link>
          </header>

          {candidates.length ? (
            <div className="queue-list">
              {candidates.map((candidate) => (
                <QueueRow candidate={candidate} key={candidate.id} />
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
                <h2>The queue is clear.</h2>
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

        <footer className="operator-footer">
          <span><Clock3 aria-hidden="true" /> Verify identity and evidence before contact</span>
          <Link href="/signals">Review source coverage <ArrowUpRight aria-hidden="true" /></Link>
        </footer>
      </div>
    </main>
  );
}
