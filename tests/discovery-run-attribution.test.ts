import assert from "node:assert/strict";
import test from "node:test";

import { persistObservedEvents } from "../lib/discovery/engine";
import type { DiscoveryRepository } from "../lib/discovery/repository";
import type { DiscoveryEvent } from "../lib/discovery/types";

test("persisted discovery events retain their ingestion run", async () => {
  const event: DiscoveryEvent = {
    confidence: 0.9,
    discoveredAt: "2026-08-05T12:00:00.000Z",
    evidence: [{ label: "Roster", url: "https://example.test/roster" }],
    idempotencyKey: "roster:candidate-1",
    occurredAt: "2026-08-05T12:00:00.000Z",
    person: {
      displayName: "Candidate One",
      identities: [{ provider: "roster-page", externalId: "candidate-1", verified: true }],
      sourceUrl: "https://example.test/roster",
    },
    source: "roster-page",
    sourceExternalId: "candidate-1",
    sourceUrl: "https://example.test/roster",
    title: "Candidate One appeared on a roster",
    type: "competition_result",
  };
  const storedInputs: Parameters<DiscoveryRepository["upsertEvent"]>[0][] = [];
  const repository = {
    findIdentityCandidates: async () => [],
    persistIdentityDecision: async () => ({
      candidateId: "candidate-1",
      created: true,
      reviewQueued: false,
    }),
    upsertEvent: async (input: Parameters<DiscoveryRepository["upsertEvent"]>[0]) => {
      storedInputs.push(input);
      return { eventId: "event-1", inserted: true };
    },
  } as unknown as DiscoveryRepository;

  await persistObservedEvents({
    repository,
    workspaceId: "workspace-1",
    runId: "62543",
    events: [event],
    aiSummaryKeys: new Set(),
  });

  assert.equal(storedInputs.length, 1);
  assert.equal(storedInputs[0]?.runId, "62543");
});
