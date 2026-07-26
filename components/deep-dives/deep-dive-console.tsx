"use client";

import { ArrowUpRight, Search, Users } from "lucide-react";
import Link from "next/link";
import { FormEvent, useState } from "react";

type DeepDiveResult = {
  candidatesCreated: number;
  candidatesUpdated: number;
  complete: boolean;
  namesFound: number;
  namesQueued: number;
  nextOffset: number;
  runId: string;
  warnings: Array<{ message: string; source: string }>;
};

export function DeepDiveConsole({
  disabled,
}: {
  disabled: boolean;
}) {
  const [url, setUrl] = useState(
    "https://stats.ioinformatics.org/results/2025",
  );
  const [maxPeople, setMaxPeople] = useState("500");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DeepDiveResult | null>(null);

  async function runDeepDive(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setRunning(true);
    setProgress(0);
    setError(null);
    setResult(null);
    try {
      const limit = Number(maxPeople);
      const batchSize = 25;
      let offset = 0;
      let aggregate: DeepDiveResult | null = null;
      while (offset < limit) {
        const response = await fetch("/api/deep-dives", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            url,
            maxPeople: limit,
            offset,
            batchSize,
          }),
        });
        const payload = (await response.json().catch(() => ({}))) as
          | DeepDiveResult
          | { error?: string };
        if (!response.ok || !("runId" in payload)) {
          throw new Error(
            "error" in payload && payload.error
              ? payload.error
              : "The page could not be imported.",
          );
        }
        aggregate = aggregate
          ? {
              ...payload,
              candidatesCreated:
                aggregate.candidatesCreated + payload.candidatesCreated,
              candidatesUpdated:
                aggregate.candidatesUpdated + payload.candidatesUpdated,
              namesFound: aggregate.namesFound + payload.namesFound,
              namesQueued: aggregate.namesQueued + payload.namesQueued,
              warnings: [...aggregate.warnings, ...payload.warnings],
            }
          : payload;
        setResult(aggregate);
        setProgress(aggregate.namesFound);
        if (payload.complete || payload.nextOffset <= offset) break;
        offset = payload.nextOffset;
      }
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The page could not be imported.",
      );
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }

  return (
    <div className="deep-dive-layout">
      <section className="deep-dive-card">
        <div className="deep-dive-card-heading">
          <span className="deep-dive-icon">
            <Users aria-hidden="true" />
          </span>
          <div>
            <h2>Research every name on a page</h2>
            <p>
              Import a public results or roster page. Every detected person is
              added to the research queue for GitHub, Hacker News, public web,
              licensed work history, and configured social enrichment.
            </p>
          </div>
        </div>
        <form className="deep-dive-form" onSubmit={runDeepDive}>
          <label>
            <span>Public roster or results URL</span>
            <input
              disabled={disabled || running}
              onChange={(event) => setUrl(event.target.value)}
              required
              type="url"
              value={url}
            />
          </label>
          <label>
            <span>Maximum names</span>
            <input
              disabled={disabled || running}
              max="500"
              min="1"
              onChange={(event) => setMaxPeople(event.target.value)}
              required
              type="number"
              value={maxPeople}
            />
          </label>
          <button
            className="editorial-button editorial-button-dark"
            disabled={
              disabled ||
              running ||
              url.trim().length < 10 ||
              Number(maxPeople) < 1
            }
            type="submit"
          >
            <Search aria-hidden="true" />
            {running
              ? `Importing${progress ? ` · ${progress} names` : ""}`
              : "Start deep dive"}
          </button>
        </form>
        <p className="deep-dive-note">
          The import is immediate. Deep research continues in the enrichment
          worker so large rosters do not have to finish inside one web request.
        </p>
      </section>

      {error ? (
        <div className="deep-dive-result deep-dive-result-error" role="alert">
          <strong>Deep dive could not start</strong>
          <p>{error}</p>
        </div>
      ) : null}

      {result ? (
        <div className="deep-dive-result" role="status">
          <div>
            <span>Names found</span>
            <strong>{result.namesFound}</strong>
          </div>
          <div>
            <span>New candidates</span>
            <strong>{result.candidatesCreated}</strong>
          </div>
          <div>
            <span>Existing candidates updated</span>
            <strong>{result.candidatesUpdated}</strong>
          </div>
          <p>
            {result.namesQueued} names are queued for deeper research. Run{" "}
            <span>{result.runId}</span>
          </p>
          <Link href="/people">
            Review imported people <ArrowUpRight aria-hidden="true" />
          </Link>
        </div>
      ) : null}
    </div>
  );
}
