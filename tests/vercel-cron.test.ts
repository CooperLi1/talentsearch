import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

type CronJob = { path: string; schedule: string };

const configuration = JSON.parse(
  readFileSync(new URL("../vercel.json", import.meta.url), "utf8"),
) as { crons: CronJob[] };

test("Vercel cron uses the full Hobby-safe daily shard budget", () => {
  assert.equal(configuration.crons.length, 100);
  assert.equal(
    new Set(configuration.crons.map((job) => `${job.path}|${job.schedule}`)).size,
    configuration.crons.length,
  );

  for (const job of configuration.crons) {
    const match = job.schedule.match(/^(\d{1,2}) (\d{1,2}) \* \* \*$/);
    assert.ok(match, `${job.schedule} must be a once-daily Hobby schedule`);
    assert.ok(Number(match[1]) >= 0 && Number(match[1]) <= 59);
    assert.ok(Number(match[2]) >= 0 && Number(match[2]) <= 23);
  }

  const count = (path: string) => configuration.crons.filter((job) => job.path === path).length;
  assert.equal(count("/api/cron/enrichment"), 48);
  assert.equal(count("/api/cron/briefs"), 27);
  assert.equal(count("/api/cron/weekly-digest"), 24);
  assert.equal(count("/api/cron/discovery"), 1);
});
