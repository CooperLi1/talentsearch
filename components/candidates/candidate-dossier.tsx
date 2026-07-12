import { CandidateActions } from "@/components/candidates/candidate-actions";
import { MessageResponse } from "@/components/ai-elements/message";
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  ExternalLink,
  Network,
} from "lucide-react";
import Link from "next/link";

export type CandidateDossierView = {
  confidence: number;
  connections: Array<{
    name: string;
    relationship: string;
    source: string;
    strength: number;
  }>;
  domains: string[];
  earlynessMarkdown: string;
  events: Array<{
    confidence: number;
    date: string;
    description: string;
    id: string;
    source: string;
    title: string;
    url: string;
  }>;
  headline: string;
  id: string;
  identities: Array<{
    label: string;
    status: "ambiguous" | "resolved" | "unresolved" | "rejected";
    url: string;
  }>;
  initials: string;
  lastSeenAt: string;
  location: string;
  momentum: number;
  name: string;
  score: number;
  stage: string;
  status: string;
  summaryMarkdown: string;
  whyNowMarkdown: string;
};

export function CandidateDossier({ candidate }: { candidate: CandidateDossierView }) {
  const identityNeedsReview =
    candidate.confidence < 0.72 ||
    candidate.identities.some((identity) => identity.status !== "resolved");
  const eligibilityNeedsReview = /high.?school|minor/i.test(candidate.stage);
  const referralDisabled = identityNeedsReview || eligibilityNeedsReview;
  const latestEvent = candidate.events[0];

  return (
    <>
      <section className="dossier-overview">
        <div className="dossier-identity-block">
          <div className="identity-mark identity-mark-dossier" aria-hidden="true">
            {candidate.initials}
          </div>
          <div>
            <span className={`status-token status-${candidate.status}`}>
              {candidate.status}
            </span>
            <p>Last checked {candidate.lastSeenAt}</p>
          </div>
        </div>

        <div className="dossier-primary">
          <div className="dossier-title-row">
            <div>
              <p className="eyebrow">Candidate dossier</p>
              <h1 className="dossier-name">{candidate.name}</h1>
              <p className="dossier-headline">{candidate.headline}</p>
              <p className="dossier-stage">
                {[candidate.stage, candidate.location].filter(Boolean).join(" · ") ||
                  "Stage and location not verified"}
              </p>
            </div>
            <div className="dossier-score">
              <strong>{candidate.score.toFixed(1)}</strong>
              <small>Review score</small>
              <span>{Math.round(candidate.confidence * 100)}% identity confidence</span>
            </div>
          </div>

          <div className="dossier-latest-evidence">
            <span>Latest verified change</span>
            {latestEvent ? (
              <a href={latestEvent.url} rel="noreferrer" target="_blank">
                <strong>{latestEvent.title}</strong>
                <small>{latestEvent.source} · {latestEvent.date}</small>
                <ArrowUpRight aria-hidden="true" />
              </a>
            ) : (
              <p>No linked evidence has been added yet.</p>
            )}
          </div>
        </div>
      </section>

      {(identityNeedsReview || eligibilityNeedsReview) && (
        <div className="dossier-guard" role="status">
          <AlertTriangle aria-hidden="true" />
          <div>
            <strong>Referral is paused.</strong>
            <span>
              {identityNeedsReview
                ? "Resolve the identity check before outreach or referral."
                : "Confirm eligibility and the appropriate contact path before outreach."}
            </span>
          </div>
        </div>
      )}

      <div className="dossier-body">
        <aside className="dossier-aside">
          <CandidateActions
            candidateId={candidate.id}
            referralDisabled={referralDisabled}
            status={candidate.status}
          />

          <div>
            <p className="eyebrow">Public profiles</p>
            {candidate.identities.length ? (
              <ul className="evidence-list">
                {candidate.identities.map((identity) => (
                  <li key={identity.url}>
                    <a href={identity.url} rel="noreferrer" target="_blank">
                      <span>
                        {identity.status === "resolved" ? (
                          <CheckCircle2 aria-hidden="true" />
                        ) : (
                          <AlertTriangle aria-hidden="true" />
                        )}
                        {identity.label}
                      </span>
                      <small>{identity.status}</small>
                      <ExternalLink aria-hidden="true" />
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="aside-empty">No public profile has been verified.</p>
            )}
          </div>

          <div>
            <p className="eyebrow">Focus</p>
            <div className="dossier-domain-list">
              {candidate.domains.map((domain) => <span key={domain}>{domain}</span>)}
            </div>
          </div>

          <Link className="editorial-button editorial-button-light" href="/people">
            Back to search
          </Link>
        </aside>

        <div className="dossier-main">
          <div className="dossier-brief-grid">
            <section className="evidence-brief">
              <p className="eyebrow">Review thesis</p>
              <MessageResponse className="prose">{candidate.summaryMarkdown}</MessageResponse>
            </section>
            <section className="evidence-brief dossier-why-now">
              <p className="eyebrow">Why now</p>
              <MessageResponse className="prose">{candidate.whyNowMarkdown}</MessageResponse>
            </section>
            <section className="evidence-brief dossier-earlyness">
              <p className="eyebrow">Why this is still early</p>
              <MessageResponse className="prose">{candidate.earlynessMarkdown}</MessageResponse>
            </section>
          </div>

          {candidate.connections.length ? (
            <section className="dossier-connections" aria-labelledby="connection-heading">
              <div>
                <p className="eyebrow">Relevant graph paths</p>
                <h2 id="connection-heading">How this person connects</h2>
              </div>
              <div className="connection-list">
                {candidate.connections.map((connection) => (
                  <article key={`${connection.name}-${connection.relationship}`}>
                    <Network aria-hidden="true" />
                    <div>
                      <strong>{connection.name}</strong>
                      <span>{connection.relationship} · {connection.source}</span>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ) : null}

          <section className="timeline" aria-labelledby="timeline-heading">
            <div className="timeline-heading-row">
              <div>
                <p className="eyebrow">Evidence timeline</p>
                <h2 className="dossier-section-title" id="timeline-heading">What changed</h2>
              </div>
              <span>{candidate.events.length} verified {candidate.events.length === 1 ? "event" : "events"}</span>
            </div>

            {candidate.events.length ? candidate.events.map((event) => (
              <article className="timeline-event" key={event.id}>
                <time className="timeline-date">{event.date}</time>
                <span className="timeline-source">{event.source}</span>
                <div>
                  <h3>{event.title}</h3>
                  <p>{event.description}</p>
                  <small>{Math.round(event.confidence * 100)}% evidence confidence</small>
                </div>
                <a href={event.url} rel="noreferrer" target="_blank" aria-label={`Open source for ${event.title}`}>
                  <ArrowUpRight aria-hidden="true" />
                </a>
              </article>
            )) : (
              <div className="compact-empty-state compact-empty-state-left">
                <h2>No evidence timeline yet</h2>
                <p>This candidate should not be acted on until source links are attached.</p>
              </div>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
